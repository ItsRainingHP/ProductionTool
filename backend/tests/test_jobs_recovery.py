# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Catalog and worker recovery tests using disposable job directories and SQLite data."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from contextlib import closing, contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import jobs as jobs_module
from app.jobs import JobStore, ResourceLimitError, sanitize_output_filename, sha256_file
from app.models import Issue, JobStatus, MappingConfig, OutputStats, PleadingSettings
from app.processor import analyze_csv


def store_at(monkeypatch: pytest.MonkeyPatch, root: Path, **limits: int) -> JobStore:
    monkeypatch.setenv("JOB_DATA_DIR", str(root))
    defaults = {"MAX_UPLOAD_BYTES": 800, "MAX_TOTAL_JOB_BYTES": 100_000,
                "MAX_JOB_WORK_BYTES": 20_000, "MAX_JOB_CREATIONS_PER_MINUTE": 30, "MAX_ACTIVE_JOBS": 20}
    defaults.update(limits)
    for key, value in defaults.items():
        monkeypatch.setenv(key, str(value))
    return JobStore()


@pytest.mark.parametrize(
    ("interrupted", "expected", "error_code"),
    [
        (JobStatus.analyzing, JobStatus.failed, "analysis_interrupted"),
        (JobStatus.preparing_review, JobStatus.needs_configuration, "review_interrupted"),
        (JobStatus.processing, JobStatus.ready_for_review, "finalization_interrupted"),
    ],
)
def test_startup_repairs_taskless_operations(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    interrupted: JobStatus, expected: JobStatus, error_code: str,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    created = store.create()
    directory = tmp_path / created.job_id
    (directory / "source.csv").write_text("A\n1\n", encoding="utf-8")
    (directory / "orphan.partial").write_text("incomplete", encoding="utf-8")
    scratch = directory / "scratch"
    scratch.mkdir()
    (scratch / "orphan.sqlite").write_text("incomplete", encoding="utf-8")
    shared_temporary = store.sqlite_temp / "orphan-sort"
    shared_temporary.write_text("incomplete", encoding="utf-8")
    with store._lock, store._connect() as connection:
        job = store._load_locked(created.job_id, connection)
        job.status = interrupted
        job.workflow = "rfp_ranges"
        if interrupted == JobStatus.preparing_review:
            (directory / "staged.txt").write_text("old review", encoding="utf-8")
            job.review_token = "old-token"
        if interrupted == JobStatus.processing:
            output = directory / "output.txt"
            output.write_text("reviewed artifact", encoding="utf-8")
            job.staged_artifact_sha256 = hashlib.sha256(output.read_bytes()).hexdigest()
            job.review_token = "current-token"
            job.review_build = jobs_module.current_build()
        store._save_locked(job, connection, preserve_task=False)
        connection.execute("UPDATE jobs SET reserved_bytes=300 WHERE job_id=?", (created.job_id,))

    restarted = store_at(monkeypatch, tmp_path)
    repaired = restarted.get(created.job_id)
    assert repaired.status == expected
    assert repaired.error_code == error_code
    assert not (directory / "orphan.partial").exists()
    assert not scratch.exists()
    assert not shared_temporary.exists()
    if interrupted == JobStatus.preparing_review:
        assert not (directory / "staged.txt").exists()
        assert repaired.review_token is None
    if interrupted == JobStatus.processing:
        assert (directory / "staged.txt").read_text(encoding="utf-8") == "reviewed artifact"
        assert not (directory / "output.txt").exists()
    with restarted._connect() as connection:
        row = connection.execute("SELECT reserved_bytes,task FROM jobs WHERE job_id=?", (created.job_id,)).fetchone()
    assert tuple(row) == (0, None)


@pytest.mark.parametrize("status,task", [(JobStatus.analyzing, "analyze"), (JobStatus.processing, "finalize")])
def test_legacy_job_catalog_imports_analysis_and_invalidates_old_finalization(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, status: JobStatus, task: str,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job = store.create()
    job.status = status
    directory = tmp_path / job.job_id
    (directory / "source.csv").write_text("A\n1\n", encoding="utf-8")
    (directory / "job.json").write_text(job.model_dump_json(), encoding="utf-8")
    with store._connect() as connection:
        connection.execute("DELETE FROM jobs WHERE job_id=?", (job.job_id,))
    invalid = tmp_path / "not-a-job"
    invalid.mkdir()
    (invalid / "job.json").write_text("{", encoding="utf-8")

    restored = store_at(monkeypatch, tmp_path)
    expected_status = JobStatus.needs_configuration if status == JobStatus.processing else status
    assert restored.get(job.job_id).status == expected_status
    with restored._connect() as connection:
        row = connection.execute("SELECT task FROM jobs WHERE job_id=?", (job.job_id,)).fetchone()
    assert row["task"] == (None if status == JobStatus.processing else task)
    claimed = restored._claim_task()
    if status == JobStatus.processing:
        assert claimed is None
    else:
        assert claimed is not None and claimed[1] == task
    assert invalid.is_dir()


def test_invalid_catalog_payload_is_removed_on_startup(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    job = store.create()
    with store._connect() as connection:
        connection.execute("UPDATE jobs SET payload='{',reserved_bytes=400 WHERE job_id=?", (job.job_id,))
    restored = store_at(monkeypatch, tmp_path)
    assert not (tmp_path / job.job_id).exists()
    with restored._connect() as connection:
        assert connection.execute("SELECT 1 FROM jobs WHERE job_id=?", (job.job_id,)).fetchone() is None


def test_creation_rate_active_capacity_and_disk_reservation_limits(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    rate = store_at(monkeypatch, tmp_path / "rate", MAX_JOB_CREATIONS_PER_MINUTE=1)
    rate.create()
    with pytest.raises(HTTPException) as too_fast:
        rate.create()
    assert too_fast.value.status_code == 429
    rate._creations[0] -= 61
    assert rate.create().job_id

    active = store_at(monkeypatch, tmp_path / "active", MAX_ACTIVE_JOBS=1)
    active.create()
    with pytest.raises(HTTPException) as too_many:
        active.create()
    assert too_many.value.status_code == 429

    full = store_at(monkeypatch, tmp_path / "full", MAX_TOTAL_JOB_BYTES=10)
    first = full.create()
    (full.root / first.job_id / "source.csv").write_bytes(b"x" * 10)
    with pytest.raises(HTTPException) as no_space:
        full.create()
    assert no_space.value.status_code == 507

    reserved = store_at(monkeypatch, tmp_path / "disk")
    job = reserved.create()
    real_usage = jobs_module.shutil.disk_usage
    monkeypatch.setattr(jobs_module.shutil, "disk_usage", lambda path: real_usage(path)._replace(free=0))
    with reserved._connect() as connection, pytest.raises(HTTPException) as disk_full:
        reserved._set_reservation_locked(job.job_id, 1, connection)
    assert disk_full.value.status_code == 507


def test_expiry_marks_active_job_for_cancellation_and_deletes_idle_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    active = store.create()
    idle = store.create()
    with store._connect() as connection:
        for job_id, status in ((active.job_id, JobStatus.analyzing), (idle.job_id, JobStatus.awaiting_upload)):
            job = store._load_locked(job_id, connection)
            job.status = status
            job.expires_at = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
            store._save_locked(job, connection, preserve_task=False)
    with pytest.raises(HTTPException) as cancel:
        store.get(active.job_id)
    assert cancel.value.status_code == 410
    with store._connect() as connection:
        row = connection.execute(
            "SELECT cancel_requested,delete_requested FROM jobs WHERE job_id=?", (active.job_id,)
        ).fetchone()
    assert tuple(row) == (1, 1)
    with pytest.raises(HTTPException) as expired:
        store.get(idle.job_id)
    assert expired.value.status_code == 410
    assert not (tmp_path / idle.job_id).exists()


def test_worker_failure_cleans_partial_data_and_releases_reservation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job = store.create()
    directory = tmp_path / job.job_id
    (directory / "staged.partial").write_bytes(b"incomplete")
    with store._connect() as connection:
        store._set_reservation_locked(job.job_id, 100, connection)
    store._mark_worker_failure(job.job_id, ResourceLimitError("work limit"))
    failed = store.get(job.job_id)
    assert failed.status == JobStatus.failed
    assert failed.error_code == "resource_limit_exceeded"
    assert not (directory / "staged.partial").exists()
    with store._connect() as connection:
        assert connection.execute("SELECT reserved_bytes FROM jobs WHERE job_id=?", (job.job_id,)).fetchone()[0] == 0
    store._mark_worker_failure(job.job_id, RuntimeError("stale worker"), "wrong-lease")
    assert store.get(job.job_id).error_code == "resource_limit_exceeded"
    store._mark_worker_failure(str(jobs_module.uuid.uuid4()), RuntimeError("deleted"))

    another = store.create()
    store._mark_worker_failure(another.job_id, HTTPException(507, "Job storage is full"))
    assert store.get(another.job_id).error_code == "resource_limit_exceeded"


def test_unavailable_artifacts_and_invalid_job_ids_are_reported(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job = store.create()
    for lookup in (lambda: store.output_path(job.job_id), lambda: store.receipt_path(job.job_id, "json"),
                   lambda: store.evidence_path(job.job_id), lambda: store.preview(job.job_id, 5),
                   lambda: store.source_path(job.job_id)):
        with pytest.raises(HTTPException) as unavailable:
            lookup()
        assert unavailable.value.status_code == 409
    with pytest.raises(HTTPException) as invalid:
        store.get("invalid")
    assert invalid.value.status_code == 404
    missing = str(jobs_module.uuid.uuid4())
    with pytest.raises(HTTPException) as nonexistent:
        store.get(missing)
    assert nonexistent.value.status_code == 404


@pytest.mark.parametrize("unsafe_id", [
    "../outside", "..\\outside", "/outside", "C:\\outside", ".", "..",
    "73bf2456-a880-4bdd-b047-e68415c34d15/../../outside",
    "73bf2456-a880-4bdd-b047-e68415c34d15\\..\\outside",
    "73bf2456-a880-4bdd-b047-e68415c34d15%2f..%2foutside",
    "urn:uuid:73bf2456-a880-4bdd-b047-e68415c34d15",
    "{73bf2456-a880-4bdd-b047-e68415c34d15}",
    "73bf2456a8804bddb047e68415c34d15",
    "73BF2456-A880-4BDD-B047-E68415C34D15",
    "73bf2456-a880-4bdd-b047-e68415c34d15\n",
])
def test_job_directory_rejects_noncanonical_ids_before_filesystem_access(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, unsafe_id: str,
) -> None:
    store = store_at(monkeypatch, tmp_path)

    def unexpected_directory_access(_path: Path) -> bool:
        raise AssertionError("An unsafe job ID reached filesystem access")

    monkeypatch.setattr(Path, "is_dir", unexpected_directory_access)
    with pytest.raises(HTTPException) as rejected:
        store._directory(unsafe_id)
    assert rejected.value.status_code == 404


@pytest.mark.parametrize("outside_root", [True, False])
def test_job_directory_rejects_symlink_escape_and_cross_job_aliases(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, outside_root: bool,
) -> None:
    root = tmp_path / "jobs"
    store = store_at(monkeypatch, root)
    destination = tmp_path / "jobs-other" if outside_root else root / str(jobs_module.uuid.uuid4())
    destination.mkdir()
    source = destination / "source.csv"
    source.write_bytes(b"protected synthetic data")
    job_id = str(jobs_module.uuid.uuid4())
    try:
        (root / job_id).symlink_to(destination, target_is_directory=True)
    except OSError:
        pytest.skip("Creating directory symlinks requires additional permissions on this platform")
    with pytest.raises(HTTPException) as rejected:
        store._directory(job_id)
    assert rejected.value.status_code == 404
    assert source.read_bytes() == b"protected synthetic data"


def test_expired_cleanup_keeps_live_worker_until_lease_ends(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job = store.create()
    with store._connect() as connection:
        current = store._load_locked(job.job_id, connection)
        current.status = JobStatus.analyzing
        current.expires_at = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        store._save_locked(current, connection)
        store._assign_lease_locked(job.job_id, connection)
    assert store.cleanup() == 0
    with store._connect() as connection:
        row = connection.execute(
            "SELECT cancel_requested,delete_requested FROM jobs WHERE job_id=?", (job.job_id,)
        ).fetchone()
    assert tuple(row) == (1, 1)
    with store._connect() as connection:
        connection.execute("UPDATE jobs SET lease_until=? WHERE job_id=?", (time.time() - 1, job.job_id))
    assert store.cleanup() == 1
    assert not (tmp_path / job.job_id).exists()


def test_health_sees_worker_claim_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    calls = 0
    real_claim = store._claim_task

    def fails_once():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("temporary SQLite contention")
        store._stop.set()
        return real_claim()

    monkeypatch.setattr(store, "_claim_task", fails_once)
    worker = threading.Thread(target=store._worker_loop)
    worker.start()
    worker.join(timeout=3)
    assert not worker.is_alive()
    assert store._worker_failures == 1


def configured_rfp(store: JobStore) -> str:
    created = store.create()
    source = store.root / created.job_id / "source.csv"
    source.write_text("Begin Bates,End Bates,RFP\nABC_1,ABC_2,RFP 01\n", encoding="utf-8")
    with store._connect() as connection:
        job = store._load_locked(created.job_id, connection)
        job.analysis = analyze_csv(source, source.name)
        job.input_sha256 = sha256_file(source)
        job.workflow = "rfp_ranges"
        job.pleading_settings = PleadingSettings()
        job.status = JobStatus.needs_configuration
        store._save_locked(job, connection, preserve_task=False)
    return created.job_id


@pytest.mark.parametrize("enabled", [True, False])
def test_true_replacement_choice_survives_catalog_reload(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, enabled: bool,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = configured_rfp(store)
    store.set_workflow(job_id, "privilege_log")
    mapping = MappingConfig.model_validate({"columns": [
        {"id": "begin", "name": "Begin", "source_fields": ["Begin Bates"]},
    ], "replace_true_with_header": enabled})
    store.set_mapping(job_id, mapping)
    restored = store_at(monkeypatch, tmp_path).get(job_id)
    assert restored.mapping is not None
    assert restored.mapping.replace_true_with_header is enabled


def reviewed_rfp(store: JobStore) -> str:
    job_id = configured_rfp(store)
    staged = store.root / job_id / "staged.txt"
    staged.write_text("RFP 01\r\nABC_1-2\r\n", encoding="utf-8", newline="")
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.status = JobStatus.ready_for_review
        job.review_token = "review-token"
        job.review_build = jobs_module.current_build()
        job.staged_artifact_sha256 = sha256_file(staged)
        job.reviewed_configuration_revision = job.configuration_revision
        job.review_stats = OutputStats(processing_ms=1, input_rows=1, output_rows=1, output_columns=2,
                                       output_cells=2, output_size_bytes=staged.stat().st_size,
                                       skipped_rows=0, formula_escapes=0, warnings_overridden=0)
        store._save_locked(job, connection, preserve_task=False)
    return job_id


@pytest.mark.parametrize("status,task", [
    (JobStatus.ready_for_review, None),
    (JobStatus.processing, None),
    (JobStatus.processing, "finalize"),
])
def test_2_0_3_legacy_review_requires_new_review_after_upgrade(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, status: JobStatus, task: str | None,
) -> None:
    monkeypatch.setattr(jobs_module, "APP_VERSION", "2.0.4")
    store = store_at(monkeypatch, tmp_path, MAX_TOTAL_JOB_BYTES=10_000_000)
    created = store.create()
    directory = tmp_path / created.job_id
    source = directory / "source.csv"
    source.write_bytes(
        b"Bates/Control #,End Bates/Control #,Subject,Tag: Attorney Client\r\n"
        b"SYN_000001,SYN_000001,Re: True-up calculation for Q3,TRUE\r\n"
        b"SYN_000002,SYN_000002,Is this statement true?,true\r\n"
        b"SYN_000003,SYN_000003,True copy of signed agreement,TrUe\r\n"
    )
    original = source.read_bytes()
    # Persist the actual pre-fix output shape and unversioned job schema from 2.0.3.
    staged = directory / "staged.csv"
    staged.write_bytes(b"\xef\xbb\xbfSubject,Reason\r\n" + b"Subject,Attorney Client\r\n" * 3)
    mapping = MappingConfig.model_validate({"columns": [
        {"id": "subject", "name": "Subject", "source_fields": ["Subject"]},
        {"id": "flag", "name": "Reason", "source_fields": ["Tag: Attorney Client"]},
    ]})
    with store._connect() as connection:
        job = store._load_locked(created.job_id, connection)
        job.analysis = analyze_csv(source, "synthetic-upgrade-2.0.3.csv")
        job.input_sha256 = sha256_file(source)
        job.workflow = "privilege_log"
        job.mapping = mapping
        job.status = status
        job.review_token = "2.0.3-review-token"
        job.staged_artifact_sha256 = sha256_file(staged)
        job.reviewed_configuration_revision = job.configuration_revision
        job.review_stats = OutputStats(processing_ms=1, input_rows=3, output_rows=3, output_columns=2,
                                       output_cells=6, output_size_bytes=staged.stat().st_size,
                                       skipped_rows=0, formula_escapes=0, warnings_overridden=0)
        store._save_locked(job, connection, task=task, task_payload={"output_filename": "old.csv", "acknowledged": []},
                           preserve_task=False)
        payload = job.model_dump(exclude={"review_build"})
        connection.execute("UPDATE jobs SET payload=?,reserved_bytes=300 WHERE job_id=?",
                           (json.dumps(payload), job.job_id))

    upgraded = store_at(monkeypatch, tmp_path, MAX_TOTAL_JOB_BYTES=10_000_000)
    restored = upgraded.get(job.job_id)
    assert restored.status == JobStatus.needs_configuration
    assert restored.error_code == "review_build_changed"
    assert restored.review_token is None
    assert restored.staged_artifact_sha256 is None
    assert restored.mapping == mapping
    assert source.read_bytes() == original
    assert not staged.exists()
    with upgraded._connect() as connection:
        row = connection.execute(
            "SELECT task,reserved_bytes,lease_token FROM jobs WHERE job_id=?", (job.job_id,),
        ).fetchone()
        assert tuple(row) == (None, 0, None)
    with pytest.raises(HTTPException) as stale:
        upgraded.enqueue_finalize(job.job_id, "old", [], "2.0.3-review-token")
    assert stale.value.status_code == 409
    with pytest.raises(HTTPException):
        upgraded.preview(job.job_id, 5)
    with pytest.raises(HTTPException):
        upgraded.receipt_path(job.job_id, "json")

    upgraded.mark_review_ready(job.job_id, [])
    claimed = upgraded._claim_task()
    assert claimed is not None
    upgraded._run_prepare_review(job.job_id, claimed[2], claimed[3])
    preview = upgraded.preview(job.job_id, 5)
    assert preview.rows == [
        ["Re: True-up calculation for Q3", "Attorney Client"],
        ["Is this statement true?", "Attorney Client"],
        ["True copy of signed agreement", "Attorney Client"],
    ]
    assert preview.review_token != "2.0.3-review-token"
    with pytest.raises(HTTPException):
        upgraded.enqueue_finalize(job.job_id, "old", [], "2.0.3-review-token")
    assert preview.review_token is not None
    upgraded.enqueue_finalize(job.job_id, "corrected", [], preview.review_token)
    claimed = upgraded._claim_task()
    assert claimed is not None
    upgraded._run_finalize(job.job_id, claimed[2], claimed[3])
    assert upgraded.get(job.job_id).status == JobStatus.complete
    assert b"Re: True-up calculation for Q3" in upgraded.output_path(job.job_id)[0].read_bytes()
    receipt = json.loads(upgraded.receipt_path(job.job_id, "json")[0].read_text(encoding="utf-8"))
    assert receipt["app_version"] == "2.0.4"
    assert receipt["image_digest"] == jobs_module.IMAGE_DIGEST
    assert receipt["output_sha256"] == sha256_file(upgraded.output_path(job.job_id)[0])
    assert source.read_bytes() == original


@pytest.mark.parametrize("identity_field", ["app_version", "build_id", "source_revision", "image_digest"])
def test_changed_build_review_is_invalidated_on_get(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, identity_field: str,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = reviewed_rfp(store)
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        assert job.review_build is not None
        setattr(job.review_build, identity_field, "older-build")
        store._save_locked(job, connection)
    restored = store.get(job_id)
    assert restored.status == JobStatus.needs_configuration
    assert restored.review_build is None
    assert restored.error_code == "review_build_changed"
    assert (tmp_path / job_id / "source.csv").is_file()
    assert not (tmp_path / job_id / "staged.txt").exists()


def test_current_build_review_survives_restart(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = reviewed_rfp(store)
    restored = store_at(monkeypatch, tmp_path).get(job_id)
    assert restored.status == JobStatus.ready_for_review
    assert restored.review_token == "review-token"
    assert restored.review_build == jobs_module.current_build()
    assert (tmp_path / job_id / "staged.txt").is_file()


def test_current_build_queued_finalization_survives_restart(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path, MAX_TOTAL_JOB_BYTES=10_000_000)
    job_id = reviewed_rfp(store)
    original = (tmp_path / job_id / "staged.txt").read_bytes()
    store.enqueue_finalize(job_id, "ranges", [], "review-token")
    restarted = store_at(monkeypatch, tmp_path, MAX_TOTAL_JOB_BYTES=10_000_000)
    assert restarted.get(job_id).status == JobStatus.processing
    claimed = restarted._claim_task()
    assert claimed is not None
    restarted._run_finalize(job_id, claimed[2], claimed[3])
    assert restarted.output_path(job_id)[0].read_bytes() == original
    receipt = json.loads(restarted.receipt_path(job_id, "json")[0].read_text(encoding="utf-8"))
    assert receipt["app_version"] == jobs_module.APP_VERSION


def test_completed_legacy_output_and_receipt_survive_upgrade(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = reviewed_rfp(store)
    directory = tmp_path / job_id
    original = (directory / "staged.txt").read_bytes()
    (directory / "staged.txt").replace(directory / "output.txt")
    receipt = b'{"app_version":"2.0.3"}\n'
    (directory / "receipt.json").write_bytes(receipt)
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.status = JobStatus.complete
        job.review_build = None
        store._save_locked(job, connection)
    upgraded = store_at(monkeypatch, tmp_path)
    assert upgraded.get(job_id).status == JobStatus.complete
    assert upgraded.output_path(job_id)[0].read_bytes() == original
    assert upgraded.receipt_path(job_id, "json")[0].read_bytes() == receipt


def test_upgrade_does_not_fail_startup_for_missing_legacy_job_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = reviewed_rfp(store)
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.review_build = None
        store._save_locked(job, connection)
    directory = tmp_path / job_id
    for file in directory.iterdir():
        file.unlink()
    directory.rmdir()
    restarted = store_at(monkeypatch, tmp_path)
    other = restarted.create()
    assert restarted.get(other.job_id).status == JobStatus.awaiting_upload


def test_finalize_worker_invalidates_older_build_after_task_claim(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id, token = processing_job(store)
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.review_build = None
        store._save_locked(job, connection)
    store._run_finalize(job_id, {"output_filename": "old.txt", "acknowledged": []}, token)
    assert store.get(job_id).status == JobStatus.needs_configuration
    assert not (tmp_path / job_id / "output.txt").exists()
    assert not (tmp_path / job_id / "receipt.json").exists()


def test_finalize_checks_build_again_inside_transaction(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = reviewed_rfp(store)
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.review_build = None
        store._save_locked(job, connection)
    monkeypatch.setattr(store, "get", lambda _job_id: job)
    with pytest.raises(HTTPException, match="application changed") as rejected:
        store.enqueue_finalize(job_id, "old", [], "review-token")
    assert rejected.value.status_code == 409


def test_catalog_migration_and_missing_or_corrupt_records(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    root = tmp_path / "old"
    root.mkdir()
    with closing(sqlite3.connect(root / "catalog.sqlite")) as connection:
        connection.execute("CREATE TABLE jobs(job_id TEXT PRIMARY KEY,payload TEXT NOT NULL,task TEXT,"
                           "task_payload TEXT,lease_until REAL,cancel_requested INTEGER NOT NULL DEFAULT 0,"
                           "updated_at REAL)")
    migrated = store_at(monkeypatch, root)
    with migrated._connect() as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
    assert {"lease_until", "reserved_bytes", "delete_requested"} <= columns

    job = migrated.create()
    with migrated._connect() as connection:
        connection.execute("DELETE FROM jobs WHERE job_id=?", (job.job_id,))
    with pytest.raises(HTTPException) as missing:
        migrated.get(job.job_id)
    assert missing.value.status_code == 404
    with migrated._connect() as connection, pytest.raises(HTTPException) as unreserved:
        migrated._set_reservation_locked(job.job_id, 1, connection)
    assert unreserved.value.status_code == 404
    with migrated._connect() as connection:
        connection.execute("INSERT INTO jobs(job_id,payload) VALUES (?,?)", (job.job_id, "{"))
    with pytest.raises(HTTPException) as corrupt:
        migrated.get(job.job_id)
    assert corrupt.value.status_code == 404


def test_create_failure_removes_empty_job_directory(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    monkeypatch.setattr(
        store, "_save_locked", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("catalog failed"))
    )
    with pytest.raises(OSError, match="catalog failed"):
        store.create()
    assert not [path for path in tmp_path.iterdir() if path.is_dir() and path.name != ".sqlite-tmp"]


def test_configuration_rejects_incompatible_workflows_and_missing_fields(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = configured_rfp(store)
    mapping = MappingConfig.model_validate({"columns": [{"id": "one", "name": "Unknown",
        "source_fields": ["Not present"], "transform": {"kind": "none"}}]})
    with pytest.raises(HTTPException, match="Select the Privilege Log workflow"):
        store.set_mapping(job_id, mapping)
    store.set_workflow(job_id, "privilege_log")
    with pytest.raises(HTTPException, match="Unknown source fields"):
        store.set_mapping(job_id, mapping)
    with pytest.raises(HTTPException, match="RFP / Pleading Ranges"):
        store.set_pleading_settings(job_id, PleadingSettings())
    with pytest.raises(HTTPException, match="at least one output column"):
        store.mark_review_ready(job_id, [])

    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.workflow = None
        store._save_locked(job, connection)
    with pytest.raises(HTTPException, match="Confirm the workflow"):
        store.mark_review_ready(job_id, [])

    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.analysis.request_count = 0
        job.workflow = "rfp_ranges"
        store._save_locked(job, connection)
    with pytest.raises(HTTPException, match="no recoverable RFP ranges"):
        store.mark_review_ready(job_id, [])
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.analysis.rfp_layout = None
        store._save_locked(job, connection)
    with pytest.raises(HTTPException, match="required for RFP range"):
        store.set_workflow(job_id, "rfp_ranges")


def test_blocked_issue_and_busy_job_cannot_be_configured(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = configured_rfp(store)
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.analysis.issues.append(Issue(code="missing_begin_bates_column", severity="error", message="Missing"))
        store._save_locked(job, connection)
    with pytest.raises(HTTPException) as blocked:
        store.mark_review_ready(job_id, [])
    assert blocked.value.status_code == 409
    assert "missing_begin_bates_column" in blocked.value.detail["issueCodes"]
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.status = JobStatus.analyzing
        store._save_locked(job, connection)
    with pytest.raises(HTTPException, match="Wait for the current"):
        store.set_workflow(job_id, "rfp_ranges")


def test_review_guards_preserve_staged_and_source_artifacts(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = reviewed_rfp(store)

    def change(**updates: object) -> None:
        with store._connect() as connection:
            job = store._load_locked(job_id, connection)
            for key, value in updates.items():
                setattr(job, key, value)
            store._save_locked(job, connection)

    change(reviewed_configuration_revision=99)
    with pytest.raises(HTTPException, match="configuration changed"):
        store.enqueue_finalize(job_id, "ranges", [], "review-token")
    change(reviewed_configuration_revision=0, reviewed_issue_codes=["other"])
    with pytest.raises(HTTPException, match="acknowledgments changed"):
        store.enqueue_finalize(job_id, "ranges", [], "review-token")
    change(reviewed_issue_codes=[])
    staged = store.root / job_id / "staged.txt"
    staged.write_text("altered", encoding="utf-8")
    with pytest.raises(HTTPException, match="unavailable or changed"):
        store.enqueue_finalize(job_id, "ranges", [], "review-token")
    staged.write_text("RFP 01\r\nABC_1-2\r\n", encoding="utf-8", newline="")
    source = store.root / job_id / "source.csv"
    source.write_text("changed", encoding="utf-8")
    with pytest.raises(HTTPException, match="source changed"):
        store.enqueue_finalize(job_id, "ranges", [], "review-token")

    change(review_token=None)
    with pytest.raises(HTTPException, match="review artifact is incomplete"):
        store.preview(job_id, 5)
    change(review_token="review-token", workflow=None)
    with pytest.raises(HTTPException, match="workflow is unavailable"):
        store.preview(job_id, 5)


def test_active_delete_and_pending_directory_removal(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = configured_rfp(store)
    with store._connect() as connection:
        job = store._load_locked(job_id, connection)
        job.status = JobStatus.analyzing
        store._save_locked(job, connection)
    assert store.delete(job_id) is True
    with store._connect() as connection:
        row = connection.execute(
            "SELECT cancel_requested,delete_requested FROM jobs WHERE job_id=?", (job_id,)
        ).fetchone()
    assert tuple(row) == (1, 1)
    assert store.cleanup() == 1

    job = store.create()
    monkeypatch.setattr(jobs_module.shutil, "rmtree", lambda _path: None)
    assert store.delete(job.job_id) is True
    pending = store.get(job.job_id)
    assert pending.error_code == "deletion_pending"
    with store._connect() as connection:
        error = connection.execute("SELECT delete_error FROM jobs WHERE job_id=?", (job.job_id,)).fetchone()[0]
        assert error == "directory_remains"


def test_cleanup_handles_corrupt_rows_and_defers_live_delete(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    corrupt = store.create()
    live = store.create()
    with store._connect() as connection:
        connection.execute("UPDATE jobs SET payload='{' WHERE job_id=?", (corrupt.job_id,))
        connection.execute("UPDATE jobs SET delete_requested=1,lease_until=? WHERE job_id=?",
                           (time.time() + 60, live.job_id))
    assert store.cleanup() == 1
    assert not (tmp_path / corrupt.job_id).exists()
    assert (tmp_path / live.job_id).exists()


@pytest.mark.parametrize("value,workflow,expected", [
    ("ranges.CSV", "rfp_ranges", "ranges.txt"),
    ("log.txt", "privilege_log", "log.csv"),
])
def test_output_filename_replaces_known_extension(value: str, workflow: str, expected: str) -> None:
    assert sanitize_output_filename(value, workflow) == expected
    for invalid in ("", "a" * 125, "bad/name"):
        with pytest.raises(HTTPException) as rejected:
            sanitize_output_filename(invalid, workflow)
        assert rejected.value.status_code == 422
    with pytest.raises(HTTPException, match="reserved"):
        sanitize_output_filename("CON", workflow)


def test_lease_heartbeat_renews_ownership_and_reports_database_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job = store.create()
    store.lease_seconds = 1
    with store._connect() as connection:
        token = store._assign_lease_locked(job.job_id, connection)
        first_heartbeat = connection.execute(
            "SELECT last_heartbeat FROM jobs WHERE job_id=?", (job.job_id,)
        ).fetchone()[0]
    with store._lease_heartbeat(job.job_id, token):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with store._connect() as connection:
                renewed = connection.execute(
                    "SELECT last_heartbeat FROM jobs WHERE job_id=?", (job.job_id,)
                ).fetchone()[0]
            if renewed > first_heartbeat:
                break
            time.sleep(0.02)
    with store._connect() as connection:
        renewed = connection.execute("SELECT last_heartbeat FROM jobs WHERE job_id=?", (job.job_id,)).fetchone()[0]
    assert renewed > first_heartbeat

    real_connect = store._connect
    main_thread = threading.current_thread()

    @contextmanager
    def failed_worker_connection():
        if threading.current_thread() is not main_thread:
            raise sqlite3.OperationalError("temporary heartbeat outage")
        with real_connect() as connection:
            yield connection

    monkeypatch.setattr(store, "_connect", failed_worker_connection)
    with store._lease_heartbeat(job.job_id, token):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and store._heartbeat_failures < 1:
            time.sleep(0.02)
    assert store._heartbeat_failures >= 1
    monkeypatch.setattr(store, "_connect", real_connect)
    with store._lease_heartbeat(job.job_id, "wrong-token"):
        time.sleep(1.2)
    with store._connect() as connection:
        assert connection.execute("SELECT lease_token FROM jobs WHERE job_id=?", (job.job_id,)).fetchone()[0] == token


def test_unknown_worker_task_fails_without_stopping_worker(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    job = store.create()
    with store._connect() as connection:
        current = store._load_locked(job.job_id, connection)
        current.status = JobStatus.analyzing
        store._save_locked(current, connection, task="unknown", task_payload={}, preserve_task=False)
    store.start()
    try:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and store.get(job.job_id).status != JobStatus.failed:
            time.sleep(0.02)
        assert store.get(job.job_id).error_code == "processing_failed"
        assert store._worker_failures == 1
        assert store.health()["status"] == "ok"
    finally:
        store.stop()


def claim_review(store: JobStore) -> tuple[str, str]:
    job_id = configured_rfp(store)
    store.mark_review_ready(job_id, [])
    claimed = store._claim_task()
    assert claimed is not None and claimed[1] == "prepare_review"
    return job_id, claimed[3]


def test_analysis_worker_ignores_stale_lease_and_cancellation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id = configured_rfp(store)
    with store._connect() as connection:
        current = store._load_locked(job_id, connection)
        current.status = JobStatus.analyzing
        store._save_locked(current, connection)
        token = store._assign_lease_locked(job_id, connection)
    store._run_analysis(job_id, "source.csv", "wrong-token")
    assert store.get(job_id).status == JobStatus.analyzing
    monkeypatch.setattr(store, "_cancelled", lambda _job_id: True)
    store._run_analysis(job_id, "source.csv", token)
    assert not (tmp_path / job_id).exists()


def test_analysis_retry_uses_fresh_scratch_after_live_lease_restart(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    original = store_at(monkeypatch, tmp_path)
    job_id = configured_rfp(original)
    scratch = tmp_path / job_id / "scratch"
    scratch.mkdir()
    with closing(sqlite3.connect(scratch / "analysis.sqlite")) as connection:
        connection.execute("CREATE TABLE analyzed_ranges (label TEXT)")
    with original._connect() as connection:
        job = original._load_locked(job_id, connection)
        job.status = JobStatus.analyzing
        job.analysis = None
        original._save_locked(job, connection, task="analyze", task_payload={"filename": "source.csv"},
                              preserve_task=False)
        original._assign_lease_locked(job_id, connection)

    restarted = store_at(monkeypatch, tmp_path)
    assert (scratch / "analysis.sqlite").exists()
    with restarted._connect() as connection:
        connection.execute("UPDATE jobs SET lease_until=? WHERE job_id=?", (time.time() - 1, job_id))
    claimed = restarted._claim_task()
    assert claimed is not None and claimed[1] == "analyze"
    restarted._run_analysis(job_id, "source.csv", claimed[3])

    job = restarted.get(job_id)
    assert job.status == JobStatus.needs_configuration
    assert job.analysis is not None and job.analysis.row_count == 1
    assert not scratch.exists()


def test_review_worker_rejects_changed_source_and_incomplete_configuration(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id, token = claim_review(store)
    store._run_prepare_review(job_id, {"acknowledged": []}, "wrong-token")
    assert store.get(job_id).status == JobStatus.preparing_review
    source = tmp_path / job_id / "source.csv"
    source.write_text("changed", encoding="utf-8")
    with pytest.raises(RuntimeError, match="source changed"):
        store._run_prepare_review(job_id, {"acknowledged": []}, token)
    with store._connect() as connection:
        current = store._load_locked(job_id, connection)
        current.analysis = None
        store._save_locked(current, connection)
    with pytest.raises(RuntimeError, match="configuration is incomplete"):
        store._run_prepare_review(job_id, {"acknowledged": []}, token)


def test_review_worker_cleans_temporary_file_after_cancellation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id, token = claim_review(store)
    monkeypatch.setattr(store, "_cancelled", lambda _job_id: True)
    store._run_prepare_review(job_id, {"acknowledged": []}, token)
    assert not (tmp_path / job_id).exists()


def processing_job(store: JobStore) -> tuple[str, str]:
    job_id = reviewed_rfp(store)
    with store._connect() as connection:
        current = store._load_locked(job_id, connection)
        current.status = JobStatus.processing
        store._save_locked(current, connection)
        token = store._assign_lease_locked(job_id, connection)
    return job_id, token


def test_finalize_worker_rejects_stale_and_changed_review(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id, token = processing_job(store)
    payload = {"output_filename": "ranges.txt", "acknowledged": []}
    store._run_finalize(job_id, payload, "wrong-token")
    assert store.get(job_id).status == JobStatus.processing
    staged = tmp_path / job_id / "staged.txt"
    staged.write_text("tampered", encoding="utf-8")
    with pytest.raises(RuntimeError, match="artifact is unavailable or changed"):
        store._run_finalize(job_id, payload, token)
    with store._connect() as connection:
        current = store._load_locked(job_id, connection)
        current.analysis = None
        store._save_locked(current, connection)
    with pytest.raises(RuntimeError, match="configuration is incomplete"):
        store._run_finalize(job_id, payload, token)


def test_finalize_worker_deletes_cancelled_job(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    store = store_at(monkeypatch, tmp_path)
    job_id, token = processing_job(store)
    monkeypatch.setattr(store, "_cancelled", lambda _job_id: True)
    store._run_finalize(job_id, {"output_filename": "ranges.txt", "acknowledged": []}, token)
    assert not (tmp_path / job_id).exists()
