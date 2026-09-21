# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Focused fault and concurrency tests for the durable job store."""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import jobs as jobs_module
from app.jobs import JobStore
from app.models import JobProgress, JobStatus


def make_store(monkeypatch: pytest.MonkeyPatch, root: Path, **settings: int) -> JobStore:
    monkeypatch.setenv("JOB_DATA_DIR", str(root))
    defaults = {
        "MAX_UPLOAD_BYTES": 800,
        "MAX_TOTAL_JOB_BYTES": 10_000,
        "MAX_JOB_WORK_BYTES": 2_000,
        "MAX_CONCURRENT_JOBS": 1,
        "JOB_LEASE_SECONDS": 15,
    }
    defaults.update(settings)
    for name, value in defaults.items():
        monkeypatch.setenv(name, str(value))
    return JobStore()


def queue_analysis(store: JobStore, job_id: str) -> None:
    with store._lock, store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.status = JobStatus.analyzing
        job.progress = JobProgress(phase="Queued", percent=5)
        store._save_locked(
            job,
            connection,
            task="analyze",
            task_payload={"filename": "source.csv"},
            preserve_task=False,
        )


def test_concurrent_uploads_reserve_aggregate_capacity(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = make_store(
        monkeypatch,
        tmp_path,
        MAX_UPLOAD_BYTES=800,
        MAX_TOTAL_JOB_BYTES=1_000,
    )
    first = store.create()
    second = store.create()

    class SlowUpload:
        filename = "source.csv"
        content_type = "text/csv"

        def __init__(self, payload: bytes, started: asyncio.Event, release: asyncio.Event) -> None:
            self.payload = payload
            self.started = started
            self.release = release
            self.sent = False

        async def read(self, _: int) -> bytes:
            if self.sent:
                return b""
            self.started.set()
            await self.release.wait()
            self.sent = True
            return self.payload

        async def close(self) -> None:
            return None

    async def exercise() -> None:
        started = asyncio.Event()
        release = asyncio.Event()
        first_upload = SlowUpload(b"A\n" + b"x" * 698, started, release)
        task = asyncio.create_task(store.upload(first.job_id, first_upload))
        await started.wait()
        with pytest.raises(HTTPException) as rejected:
            await store.upload(second.job_id, SlowUpload(b"A\n", asyncio.Event(), asyncio.Event()))
        assert rejected.value.status_code == 507
        release.set()
        await task

    asyncio.run(exercise())
    assert (tmp_path / first.job_id / "source.csv").stat().st_size == 700
    with store._connect() as connection:
        reserved = connection.execute("SELECT COALESCE(SUM(reserved_bytes),0) FROM jobs").fetchone()[0]
    assert reserved == 0


def test_startup_repairs_interrupted_upload(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = make_store(monkeypatch, tmp_path)
    job = store.create()
    directory = tmp_path / job.job_id
    (directory / "source.csv").write_text("incomplete", encoding="utf-8")
    (directory / "source.partial").write_text("partial", encoding="utf-8")
    with store._lock, store._connect() as connection:
        current = store._load_locked(job.job_id, connection)
        current.status = JobStatus.uploading
        current.progress = JobProgress(phase="Uploading", percent=10)
        store._save_locked(current, connection, preserve_task=False)
        connection.execute("UPDATE jobs SET reserved_bytes=400 WHERE job_id=?", (job.job_id,))

    restarted = make_store(monkeypatch, tmp_path)
    repaired = restarted.get(job.job_id)
    assert repaired.status == JobStatus.awaiting_upload
    assert repaired.error_code == "upload_interrupted"
    assert not (directory / "source.csv").exists()
    assert not (directory / "source.partial").exists()
    with restarted._connect() as connection:
        assert connection.execute("SELECT reserved_bytes FROM jobs WHERE job_id=?", (job.job_id,)).fetchone()[0] == 0


def test_live_lease_survives_second_store_startup(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    first = make_store(monkeypatch, tmp_path)
    job = first.create()
    queue_analysis(first, job.job_id)
    claim = first._claim_task()
    assert claim is not None

    second = make_store(monkeypatch, tmp_path)
    assert second._claim_task() is None
    with second._connect() as connection:
        row = connection.execute(
            "SELECT lease_owner,lease_token,lease_until FROM jobs WHERE job_id=?", (job.job_id,)
        ).fetchone()
    assert row["lease_owner"] == first.instance_id
    assert row["lease_token"] == claim[3]
    assert row["lease_until"] > time.time()


def test_failed_deletion_remains_visible_and_retries(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = make_store(monkeypatch, tmp_path)
    job = store.create()
    (tmp_path / job.job_id / "source.csv").write_text("A\nvalue\n", encoding="utf-8")
    real_rmtree = jobs_module.shutil.rmtree
    attempts = 0

    def flaky_rmtree(path: Path) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise PermissionError("simulated lock")
        real_rmtree(path)

    monkeypatch.setattr(jobs_module.shutil, "rmtree", flaky_rmtree)
    assert store.delete(job.job_id) is True
    pending = store.get(job.job_id)
    assert pending.status == JobStatus.expired
    assert pending.error_code == "deletion_pending"
    with store._connect() as connection:
        row = connection.execute(
            "SELECT delete_requested,delete_error FROM jobs WHERE job_id=?", (job.job_id,)
        ).fetchone()
    assert row["delete_requested"] == 1
    assert row["delete_error"] == "PermissionError"
    assert store.cleanup() == 1
    assert not (tmp_path / job.job_id).exists()


def test_invalid_task_does_not_kill_worker_and_health_reports_liveness(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    store = make_store(monkeypatch, tmp_path)
    job = store.create()
    queue_analysis(store, job.job_id)
    with store._connect() as connection:
        connection.execute("UPDATE jobs SET task_payload='{' WHERE job_id=?", (job.job_id,))
    store.start()
    try:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            failed = store.get(job.job_id)
            if failed.error_code == "invalid_task_payload":
                break
            time.sleep(0.02)
        assert failed.status == JobStatus.failed
        assert failed.error_code == "invalid_task_payload"
        health = store.health()
        assert health["status"] == "ok"
        assert health["workers_alive"] == 1
        assert health["queued_jobs"] == 0
    finally:
        store.stop()

    store._workers = [threading.Thread()]
    with pytest.raises(HTTPException) as unavailable:
        store.health()
    assert unavailable.value.status_code == 503
    assert unavailable.value.detail["status"] == "unavailable"


def test_worker_completes_a_normally_leased_analysis(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    store = make_store(monkeypatch, tmp_path)
    job = store.create()
    (tmp_path / job.job_id / "source.csv").write_text(
        "Bates/Control #,End Bates/Control #,RFP\nTEST_0001,TEST_0002,RFP 01\n",
        encoding="utf-8",
    )
    queue_analysis(store, job.job_id)
    store.start()
    try:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            analyzed = store.get(job.job_id)
            if analyzed.status in {JobStatus.needs_configuration, JobStatus.failed}:
                break
            time.sleep(0.02)
        assert analyzed.status == JobStatus.needs_configuration
        assert analyzed.analysis is not None
        assert analyzed.analysis.row_count == 1
        with store._connect() as connection:
            row = connection.execute(
                "SELECT task,lease_owner,lease_token,reserved_bytes FROM jobs WHERE job_id=?",
                (job.job_id,),
            ).fetchone()
        assert tuple(row) == (None, None, None, 0)
    finally:
        store.stop()
