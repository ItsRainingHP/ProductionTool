# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Durable job catalog, state transitions, worker queue, expiry, and output handling."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from collections import deque
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .evidence import build_evidence_package
from .models import (
    Capabilities,
    JobProgress,
    JobStatus,
    JobView,
    JobWorkflow,
    MappingConfig,
    PleadingSettings,
    Preview,
    Receipt,
)
from .processor import ProcessingLimitError, analyze_csv, build_artifact_preview, write_output
from .release import APP_VERSION, BUILD_ID, IMAGE_DIGEST, SOURCE_REVISION

SAFE_FILENAME = re.compile(r"^[^<>:\"/\\|?*\x00-\x1f]+$")
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
ALLOWED_CSV_CONTENT_TYPES = {
    "",
    "application/csv",
    "application/octet-stream",
    "application/vnd.ms-excel",
    "text/csv",
    "text/plain",
}
MAX_SOURCE_FILENAME_LENGTH = 255
LOGGER = logging.getLogger("production_tool.jobs")


def log_event(event: str, **fields: object) -> None:
    """Emit a machine-readable event without source filenames or CSV content."""
    LOGGER.info(json.dumps({"event": event, **fields}, separators=(",", ":"), sort_keys=True))


class ResourceLimitError(RuntimeError):
    pass


class JobStore:
    def __init__(self) -> None:
        default_root = Path(__file__).resolve().parents[2] / "data" / "jobs"
        self.root = Path(os.getenv("JOB_DATA_DIR", str(default_root)))
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = int(os.getenv("MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))
        self.ttl_seconds = int(os.getenv("JOB_TTL_SECONDS", str(4 * 60 * 60)))
        self.ttl = timedelta(seconds=self.ttl_seconds)
        self.max_workers = max(1, int(os.getenv("MAX_CONCURRENT_JOBS", "2")))
        self.max_active_jobs = max(1, int(os.getenv("MAX_ACTIVE_JOBS", "20")))
        self.max_total_bytes = int(os.getenv("MAX_TOTAL_JOB_BYTES", str(5 * 1024 * 1024 * 1024)))
        self.max_work_bytes = int(os.getenv("MAX_JOB_WORK_BYTES", str(2 * 1024 * 1024 * 1024)))
        self.creation_rate = max(1, int(os.getenv("MAX_JOB_CREATIONS_PER_MINUTE", "30")))
        self.lease_seconds = max(15, int(os.getenv("JOB_LEASE_SECONDS", "60")))
        self.instance_id = str(uuid.uuid4())
        self.database = self.root / "catalog.sqlite"
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._workers: list[threading.Thread] = []
        self._creations: deque[float] = deque()
        self._worker_failures = 0
        self._heartbeat_failures = 0
        self._initialize_catalog()
        self._import_legacy_jobs()
        self._reconcile_startup()
        self.cleanup()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize_catalog(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY, payload TEXT NOT NULL, task TEXT, task_payload TEXT,
                    lease_until REAL, lease_owner TEXT, lease_token TEXT, last_heartbeat REAL,
                    reserved_bytes INTEGER NOT NULL DEFAULT 0,
                    delete_requested INTEGER NOT NULL DEFAULT 0, delete_error TEXT,
                    cancel_requested INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL
                )"""
            )
            existing = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
            migrations = {
                "lease_owner": "ALTER TABLE jobs ADD COLUMN lease_owner TEXT",
                "lease_token": "ALTER TABLE jobs ADD COLUMN lease_token TEXT",
                "last_heartbeat": "ALTER TABLE jobs ADD COLUMN last_heartbeat REAL",
                "reserved_bytes": "ALTER TABLE jobs ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0",
                "delete_requested": "ALTER TABLE jobs ADD COLUMN delete_requested INTEGER NOT NULL DEFAULT 0",
                "delete_error": "ALTER TABLE jobs ADD COLUMN delete_error TEXT",
            }
            for column, statement in migrations.items():
                if column not in existing:
                    connection.execute(statement)

    def _import_legacy_jobs(self) -> None:
        with self._lock, self._connect() as connection:
            known = {row[0] for row in connection.execute("SELECT job_id FROM jobs")}
            for directory in self.root.iterdir():
                metadata = directory / "job.json"
                if not directory.is_dir() or directory.name in known or not metadata.is_file():
                    continue
                try:
                    job = JobView.model_validate_json(metadata.read_text(encoding="utf-8"))
                    uuid.UUID(job.job_id)
                except (OSError, ValueError):
                    continue
                task = None
                if job.status == JobStatus.analyzing and (directory / "source.csv").is_file():
                    task = "analyze"
                elif job.status == JobStatus.processing and (directory / "source.csv").is_file():
                    task = "finalize"
                connection.execute(
                    "INSERT OR IGNORE INTO jobs(job_id,payload,task,task_payload,updated_at) VALUES (?,?,?,?,?)",
                    (job.job_id, job.model_dump_json(), task, "{}", time.time()),
                )

    def _reconcile_startup(self) -> None:
        """Repair interrupted local operations without disturbing another instance's live lease."""
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                "SELECT job_id,payload,task,lease_until,delete_requested,reserved_bytes FROM jobs"
            ).fetchall()
            for row in rows:
                live_lease = bool(row["lease_until"] and row["lease_until"] > now)
                if row["delete_requested"] or live_lease:
                    continue
                directory = self._directory(row["job_id"], require_exists=False)
                for partial in directory.glob("*.partial") if directory.is_dir() else ():
                    with suppress(OSError):
                        partial.unlink()
                try:
                    job = JobView.model_validate_json(row["payload"])
                except ValueError:
                    connection.execute(
                        "UPDATE jobs SET task=NULL,lease_until=NULL,lease_owner=NULL,lease_token=NULL,"
                        "last_heartbeat=NULL,reserved_bytes=0,delete_requested=1,"
                        "delete_error='invalid_catalog_payload',cancel_requested=1 WHERE job_id=?",
                        (row["job_id"],),
                    )
                    continue
                self._repair_taskless_active_locked(job, row["task"], connection)
                if row["task"] is None:
                    connection.execute(
                        "UPDATE jobs SET lease_until=NULL,lease_owner=NULL,lease_token=NULL,"
                        "last_heartbeat=NULL,reserved_bytes=0 WHERE job_id=?",
                        (row["job_id"],),
                    )

    def _repair_taskless_active_locked(self, job: JobView, task: str | None, connection: sqlite3.Connection) -> None:
        if task is not None:
            return
        directory = self._directory(job.job_id, require_exists=False)
        if job.status == JobStatus.uploading:
            for name in ("source.csv", "source.partial"):
                with suppress(OSError):
                    (directory / name).unlink(missing_ok=True)
            job.status = JobStatus.awaiting_upload
            job.progress = JobProgress()
            job.error = "The previous upload was interrupted. Select the source CSV again."
            job.error_code = "upload_interrupted"
            job.cancel_requested = False
            self._save_locked(job, connection, preserve_task=False)
        elif job.status == JobStatus.analyzing:
            job.status = JobStatus.failed
            job.error = "CSV analysis was interrupted. Upload the source CSV again."
            job.error_code = "analysis_interrupted"
            self._save_locked(job, connection, preserve_task=False)
        elif job.status == JobStatus.preparing_review:
            self._remove_outputs(job.job_id)
            self._invalidate_review(job)
            job.status = JobStatus.needs_configuration
            job.error = "Review preparation was interrupted. Prepare the output for review again."
            job.error_code = "review_interrupted"
            self._save_locked(job, connection, preserve_task=False)
        elif job.status == JobStatus.processing:
            output = directory / ("output.txt" if job.workflow == "rfp_ranges" else "output.csv")
            staged = self._staged_path(job)
            if output.is_file() and job.staged_artifact_sha256 and sha256_file(output) == job.staged_artifact_sha256:
                output.replace(staged)
            job.status = JobStatus.ready_for_review if staged.is_file() and job.review_token else JobStatus.failed
            job.error = "Final packaging was interrupted. Confirm the review and finalize again."
            job.error_code = "finalization_interrupted"
            self._save_locked(job, connection, preserve_task=False)

    def start(self) -> None:
        with self._lock:
            self._workers = [worker for worker in self._workers if worker.is_alive()]
            self._stop.clear()
            for index in range(len(self._workers), self.max_workers):
                worker = threading.Thread(
                    target=self._worker_loop,
                    name=f"production-worker-{index + 1}",
                    daemon=True,
                )
                worker.start()
                self._workers.append(worker)
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        for worker in self._workers:
            worker.join(timeout=10)
        self._workers.clear()

    def capabilities(self) -> Capabilities:
        return Capabilities(
            max_upload_bytes=self.max_bytes,
            job_ttl_seconds=self.ttl_seconds,
            max_active_jobs=self.max_active_jobs,
            max_total_job_bytes=self.max_total_bytes,
            max_mapping_columns=100,
            max_source_fields_per_column=100,
            supported_content_types=sorted(ALLOWED_CSV_CONTENT_TYPES),
            features=[
                "durable_jobs",
                "mapping_templates",
                "processing_receipts",
                "exact_review_artifacts",
                "evidence_packages",
            ],
        )

    def health(self) -> dict[str, int | str]:
        now = time.time()
        with self._lock, self._connect() as connection:
            queued = connection.execute("SELECT COUNT(*) FROM jobs WHERE task IS NOT NULL").fetchone()[0]
            active = connection.execute(
                "SELECT COUNT(*) FROM jobs "
                "WHERE json_valid(payload) AND "
                "json_extract(payload, '$.status') IN ('uploading','analyzing','preparing_review','processing')"
            ).fetchone()[0]
            total = connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
            reserved = connection.execute("SELECT COALESCE(SUM(reserved_bytes),0) FROM jobs").fetchone()[0]
            pending_deletions = connection.execute("SELECT COUNT(*) FROM jobs WHERE delete_requested=1").fetchone()[0]
            deletion_failures = connection.execute(
                "SELECT COUNT(*) FROM jobs WHERE delete_requested=1 AND delete_error IS NOT NULL"
            ).fetchone()[0]
            oldest_queued = connection.execute("SELECT MIN(updated_at) FROM jobs WHERE task IS NOT NULL").fetchone()[0]
            oldest_heartbeat = connection.execute(
                "SELECT MIN(last_heartbeat) FROM jobs WHERE task IS NOT NULL AND last_heartbeat IS NOT NULL"
            ).fetchone()[0]
        workers_alive = sum(worker.is_alive() for worker in self._workers)
        stored = self._total_job_bytes()
        status = "ok" if workers_alive == self.max_workers else ("degraded" if workers_alive else "unavailable")
        result: dict[str, int | str] = {
            "status": status,
            "jobs": total,
            "active_jobs": active,
            "queued_jobs": queued,
            "stored_bytes": stored,
            "reserved_bytes": reserved,
            "committed_bytes": stored + reserved,
            "disk_free_bytes": shutil.disk_usage(self.root).free,
            "workers_configured": self.max_workers,
            "workers_alive": workers_alive,
            "worker_failures": self._worker_failures,
            "heartbeat_failures": self._heartbeat_failures,
            "pending_deletions": pending_deletions,
            "deletion_failures": deletion_failures,
            "oldest_queued_seconds": max(0, int(now - oldest_queued)) if oldest_queued else 0,
            "oldest_heartbeat_seconds": max(0, int(now - oldest_heartbeat)) if oldest_heartbeat else 0,
        }
        if workers_alive == 0:
            raise HTTPException(503, result)
        return result

    def _directory(self, job_id: str, *, require_exists: bool = True) -> Path:
        try:
            uuid.UUID(job_id)
        except ValueError as exc:
            raise HTTPException(404, "Job not found") from exc
        directory = self.root / job_id
        if require_exists and not directory.is_dir():
            raise HTTPException(404, "Job not found")
        return directory

    def _load_locked(self, job_id: str, connection: sqlite3.Connection) -> JobView:
        self._directory(job_id)
        row = connection.execute("SELECT payload,cancel_requested FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Job not found")
        try:
            job = JobView.model_validate_json(row["payload"])
        except ValueError as exc:
            raise HTTPException(404, "Job not found") from exc
        job.cancel_requested = bool(row["cancel_requested"])
        if datetime.fromisoformat(job.expires_at) <= datetime.now(UTC) and job.status in {
            JobStatus.uploading,
            JobStatus.analyzing,
            JobStatus.preparing_review,
            JobStatus.processing,
        }:
            job.cancel_requested = True
            connection.execute("UPDATE jobs SET cancel_requested=1,delete_requested=1 WHERE job_id=?", (job_id,))
            raise HTTPException(410, "Job expired and cancellation was requested")
        if datetime.fromisoformat(job.expires_at) <= datetime.now(UTC):
            self._delete_locked(job_id, connection)
            raise HTTPException(410, "Job expired")
        return job

    def _save_locked(
        self,
        job: JobView,
        connection: sqlite3.Connection,
        *,
        task: str | None = None,
        task_payload: dict | None = None,
        preserve_task: bool = True,
    ) -> JobView:
        existing = connection.execute("SELECT task,task_payload FROM jobs WHERE job_id=?", (job.job_id,)).fetchone()
        job.revision += 1
        effective_task = existing["task"] if existing and preserve_task else task
        effective_payload = existing["task_payload"] if existing and preserve_task else json.dumps(task_payload or {})
        connection.execute(
            """INSERT INTO jobs(job_id,payload,task,task_payload,cancel_requested,updated_at)
               VALUES (?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload,
               task=excluded.task,task_payload=excluded.task_payload,
               cancel_requested=excluded.cancel_requested,updated_at=excluded.updated_at""",
            (
                job.job_id,
                job.model_dump_json(),
                effective_task,
                effective_payload,
                int(job.cancel_requested),
                time.time(),
            ),
        )
        if not preserve_task:
            connection.execute(
                "UPDATE jobs SET lease_until=NULL,lease_owner=NULL,lease_token=NULL,last_heartbeat=NULL WHERE job_id=?",
                (job.job_id,),
            )
        return job

    def _total_job_bytes(self) -> int:
        total = 0
        for path in self.root.rglob("*"):
            if path.is_file() and path != self.database and not path.name.startswith("catalog.sqlite-"):
                with suppress(OSError):
                    total += path.stat().st_size
        return total

    def _set_reservation_locked(self, job_id: str, target_bytes: int, connection: sqlite3.Connection) -> None:
        target_bytes = max(0, target_bytes)
        row = connection.execute("SELECT reserved_bytes FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Job not found")
        current = int(row[0])
        additional = target_bytes - current
        if additional > 0:
            reserved = int(connection.execute("SELECT COALESCE(SUM(reserved_bytes),0) FROM jobs").fetchone()[0])
            stored = self._total_job_bytes()
            if stored + reserved + additional > self.max_total_bytes:
                raise HTTPException(507, "Job storage is full. Try again after older jobs expire.")
            if reserved + additional > shutil.disk_usage(self.root).free:
                raise HTTPException(507, "The job volume does not have enough free space.")
        connection.execute("UPDATE jobs SET reserved_bytes=? WHERE job_id=?", (target_bytes, job_id))

    def _consume_reservation_locked(self, job_id: str, materialized_bytes: int, connection: sqlite3.Connection) -> None:
        connection.execute(
            "UPDATE jobs SET reserved_bytes=MAX(0,reserved_bytes-?) WHERE job_id=?",
            (max(0, materialized_bytes), job_id),
        )

    def _assign_lease_locked(self, job_id: str, connection: sqlite3.Connection, *, token: str | None = None) -> str:
        lease_token = token or str(uuid.uuid4())
        now = time.time()
        connection.execute(
            "UPDATE jobs SET lease_until=?,lease_owner=?,lease_token=?,last_heartbeat=? WHERE job_id=?",
            (now + self.lease_seconds, self.instance_id, lease_token, now, job_id),
        )
        return lease_token

    def _lease_owned_locked(self, job_id: str, lease_token: str, connection: sqlite3.Connection) -> bool:
        row = connection.execute(
            "SELECT 1 FROM jobs WHERE job_id=? AND lease_owner=? AND lease_token=?",
            (job_id, self.instance_id, lease_token),
        ).fetchone()
        return bool(row)

    @contextmanager
    def _lease_heartbeat(self, job_id: str, lease_token: str) -> Iterator[None]:
        stopped = threading.Event()
        interval = max(1.0, self.lease_seconds / 3)

        def heartbeat() -> None:
            while not stopped.wait(interval):
                try:
                    now = time.time()
                    with self._connect() as connection:
                        updated = connection.execute(
                            "UPDATE jobs SET lease_until=?,last_heartbeat=? "
                            "WHERE job_id=? AND lease_owner=? AND lease_token=?",
                            (now + self.lease_seconds, now, job_id, self.instance_id, lease_token),
                        ).rowcount
                    if not updated:
                        return
                except Exception:
                    self._heartbeat_failures += 1
                    LOGGER.exception(
                        json.dumps(
                            {"event": "job_lease_heartbeat_failed", "job_id": job_id},
                            separators=(",", ":"),
                            sort_keys=True,
                        )
                    )

        thread = threading.Thread(
            target=heartbeat,
            name=f"production-heartbeat-{job_id[:8]}",
            daemon=True,
        )
        thread.start()
        try:
            yield
        finally:
            stopped.set()
            thread.join(timeout=2)

    def create(self) -> JobView:
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now_monotonic = time.monotonic()
            while self._creations and now_monotonic - self._creations[0] >= 60:
                self._creations.popleft()
            if len(self._creations) >= self.creation_rate:
                raise HTTPException(429, "Too many jobs were created. Try again shortly.")
            if connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] >= self.max_active_jobs:
                raise HTTPException(429, "The active job limit has been reached.")
            reserved = int(connection.execute("SELECT COALESCE(SUM(reserved_bytes),0) FROM jobs").fetchone()[0])
            if self._total_job_bytes() + reserved >= self.max_total_bytes:
                raise HTTPException(507, "Job storage is full. Try again after older jobs expire.")
            self._creations.append(now_monotonic)
            now = datetime.now(UTC)
            job_id = str(uuid.uuid4())
            directory = self.root / job_id
            directory.mkdir(parents=True)
            job = JobView(
                job_id=job_id,
                created_at=now.isoformat(),
                expires_at=(now + self.ttl).isoformat(),
                status=JobStatus.awaiting_upload,
                progress=JobProgress(),
            )
            try:
                saved = self._save_locked(job, connection, preserve_task=False)
            except Exception:
                with suppress(OSError):
                    directory.rmdir()
                raise
            log_event("job_created", job_id=job_id)
            return saved

    def get(self, job_id: str) -> JobView:
        with self._lock, self._connect() as connection:
            return self._load_locked(job_id, connection)

    async def upload(self, job_id: str, upload: UploadFile) -> JobView:
        raw_filename = (upload.filename or "").strip()
        filename = Path(raw_filename.replace("\\", "/")).name
        if (
            not filename
            or len(raw_filename) > MAX_SOURCE_FILENAME_LENGTH
            or len(filename) > MAX_SOURCE_FILENAME_LENGTH
            or any(ord(character) < 32 for character in filename)
            or Path(filename).suffix.casefold() != ".csv"
        ):
            raise HTTPException(415, "Only CSV files are accepted")
        content_type = (upload.content_type or "").split(";", 1)[0].strip().casefold()
        if content_type not in ALLOWED_CSV_CONTENT_TYPES:
            raise HTTPException(415, "The uploaded file does not have a supported CSV content type")
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            job = self._load_locked(job_id, connection)
            if job.status not in {JobStatus.awaiting_upload, JobStatus.failed}:
                raise HTTPException(409, "This job is not accepting an upload")
            self._set_reservation_locked(job_id, self.max_bytes, connection)
            job.status = JobStatus.uploading
            job.progress = JobProgress(phase="Uploading", percent=0)
            job.error = job.error_code = None
            self._save_locked(job, connection)
            lease_token = self._assign_lease_locked(job_id, connection)
        destination = self._directory(job_id) / "source.csv"
        temporary = destination.with_suffix(".partial")
        total = 0
        upload_digest = hashlib.sha256()
        try:
            with self._lease_heartbeat(job_id, lease_token), temporary.open("wb") as handle:
                while chunk := await upload.read(1024 * 1024):
                    total += len(chunk)
                    upload_digest.update(chunk)
                    if total > self.max_bytes:
                        raise HTTPException(413, f"File exceeds the {self.max_bytes}-byte upload limit")
                    handle.write(chunk)
                    handle.flush()
                    with self._lock, self._connect() as connection:
                        connection.execute("BEGIN IMMEDIATE")
                        if not self._lease_owned_locked(job_id, lease_token, connection):
                            raise RuntimeError("The upload lease was lost")
                        self._consume_reservation_locked(job_id, len(chunk), connection)
            temporary.replace(destination)
            with self._lock, self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                if not self._lease_owned_locked(job_id, lease_token, connection):
                    raise RuntimeError("The upload lease was lost")
                job = self._load_locked(job_id, connection)
                job.status = JobStatus.analyzing
                job.progress = JobProgress(phase="Queued for analysis", percent=5, bytes_processed=total)
                job.input_sha256 = upload_digest.hexdigest()
                job.uploaded_at = datetime.now(UTC).isoformat()
                self._set_reservation_locked(job_id, 0, connection)
                self._save_locked(
                    job, connection, task="analyze", task_payload={"filename": filename}, preserve_task=False
                )
            self._wake.set()
            return job
        except Exception:
            temporary.unlink(missing_ok=True)
            destination.unlink(missing_ok=True)
            with self._lock, self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "UPDATE jobs SET reserved_bytes=0,lease_until=NULL,lease_owner=NULL,"
                    "lease_token=NULL,last_heartbeat=NULL WHERE job_id=?",
                    (job_id,),
                )
                try:
                    job = self._load_locked(job_id, connection)
                    job.status, job.progress = JobStatus.awaiting_upload, JobProgress()
                    self._save_locked(job, connection, preserve_task=False)
                except HTTPException:
                    pass
            raise
        finally:
            await upload.close()

    def source_path(self, job_id: str) -> Path:
        path = self._directory(job_id) / "source.csv"
        if not path.exists():
            raise HTTPException(409, "No source file has been uploaded")
        return path

    def _ensure_configurable(self, job: JobView) -> None:
        if job.status in {JobStatus.uploading, JobStatus.analyzing, JobStatus.preparing_review, JobStatus.processing}:
            raise HTTPException(409, "Wait for the current job operation to finish")
        if not job.analysis or job.status == JobStatus.failed:
            raise HTTPException(409, "A readable CSV must be uploaded first")

    def set_workflow(self, job_id: str, workflow: JobWorkflow) -> JobView:
        with self._lock, self._connect() as connection:
            job = self._load_locked(job_id, connection)
            self._ensure_configurable(job)
            analysis = job.analysis
            if analysis is None:
                raise HTTPException(409, "A readable CSV must be uploaded first")
            if workflow == "rfp_ranges" and (
                not analysis.rfp_layout or not analysis.begin_bates_header or not analysis.end_bates_header
            ):
                raise HTTPException(409, "This CSV does not contain the columns required for RFP range output")
            job.workflow = workflow
            job.mapping = None if workflow == "rfp_ranges" else job.mapping
            job.pleading_settings = (job.pleading_settings or PleadingSettings()) if workflow == "rfp_ranges" else None
            self._invalidate_review(job)
            job.status = JobStatus.needs_configuration
            self._remove_outputs(job_id)
            return self._save_locked(job, connection)

    def set_pleading_settings(self, job_id: str, settings: PleadingSettings) -> JobView:
        with self._lock, self._connect() as connection:
            job = self._load_locked(job_id, connection)
            self._ensure_configurable(job)
            if job.workflow != "rfp_ranges":
                raise HTTPException(409, "Select the RFP / Pleading Ranges workflow first")
            job.pleading_settings = settings
            self._invalidate_review(job)
            job.status = JobStatus.needs_configuration
            self._remove_outputs(job_id)
            return self._save_locked(job, connection)

    def set_mapping(self, job_id: str, mapping: MappingConfig) -> JobView:
        with self._lock, self._connect() as connection:
            job = self._load_locked(job_id, connection)
            self._ensure_configurable(job)
            analysis = job.analysis
            if analysis is None:
                raise HTTPException(409, "A readable CSV must be uploaded first")
            if job.workflow != "privilege_log":
                raise HTTPException(409, "Select the Privilege Log workflow first")
            unknown = sorted(
                {field for column in mapping.columns for field in column.source_fields} - set(analysis.headers)
            )
            if unknown:
                raise HTTPException(422, f"Unknown source fields: {', '.join(unknown)}")
            job.mapping = mapping
            self._invalidate_review(job)
            job.status = JobStatus.needs_configuration
            self._remove_outputs(job_id)
            return self._save_locked(job, connection)

    def _invalidate_review(self, job: JobView) -> None:
        job.configuration_revision += 1
        job.reviewed_configuration_revision = None
        job.review_token = None
        job.staged_artifact_sha256 = None
        job.staged_at = None
        job.review_stats = None
        job.reviewed_issue_codes = []
        job.output_filename = None
        job.output_stats = None

    def _validate_acknowledgments(self, job: JobView, acknowledged: list[str]) -> list[str]:
        if job.analysis is None:
            raise HTTPException(409, "A readable CSV must be uploaded first")
        acknowledged_codes = set(acknowledged)
        overrideable = {issue.code for issue in job.analysis.issues if issue.overrideable}
        unknown = sorted(acknowledged_codes - overrideable)
        if unknown:
            raise HTTPException(422, f"Unknown issue acknowledgments: {', '.join(unknown)}")
        blockers = [issue.code for issue in job.analysis.issues if issue.severity in {"error", "fatal"}]
        if blockers:
            raise HTTPException(
                409,
                {"message": "This CSV has blocking validation issues and must be replaced", "issueCodes": blockers},
            )
        missing = sorted(overrideable - acknowledged_codes)
        if missing:
            raise HTTPException(409, {"message": "Acknowledge every warning before review", "issueCodes": missing})
        return sorted(acknowledged_codes)

    def mark_review_ready(self, job_id: str, acknowledged: list[str]) -> JobView:
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            job = self._load_locked(job_id, connection)
            self._ensure_configurable(job)
            analysis = job.analysis
            if analysis is None:
                raise HTTPException(409, "A readable CSV must be uploaded first")
            if not job.workflow:
                raise HTTPException(409, "Confirm the workflow before preparing review")
            if job.workflow == "rfp_ranges" and analysis.request_count == 0:
                raise HTTPException(409, "The selected workflow has no recoverable RFP ranges")
            if job.workflow == "privilege_log" and not job.mapping:
                raise HTTPException(409, "Configure at least one output column")
            acknowledged_codes = self._validate_acknowledgments(job, acknowledged)
            self._remove_outputs(job_id)
            self._set_reservation_locked(job_id, self.max_work_bytes, connection)
            job.status = JobStatus.preparing_review
            job.progress = JobProgress(phase="Queued to prepare exact review artifact", percent=5)
            job.error = job.error_code = None
            self._save_locked(
                job,
                connection,
                task="prepare_review",
                task_payload={"acknowledged": acknowledged_codes},
                preserve_task=False,
            )
        self._wake.set()
        return job

    def _staged_path(self, job: JobView) -> Path:
        suffix = ".txt" if job.workflow == "rfp_ranges" else ".csv"
        return self._directory(job.job_id) / f"staged{suffix}"

    def enqueue_finalize(
        self, job_id: str, output_filename: str, acknowledged: list[str], review_token: str
    ) -> JobView:
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            job = self._load_locked(job_id, connection)
            if job.status != JobStatus.ready_for_review:
                raise HTTPException(409, "Prepare and review the current output before finalizing")
            if not job.review_token or review_token != job.review_token:
                raise HTTPException(409, "The review token is stale; prepare the output for review again")
            if job.reviewed_configuration_revision != job.configuration_revision:
                raise HTTPException(409, "The configuration changed after review")
            workflow = job.workflow
            analysis = job.analysis
            if workflow is None or analysis is None:
                raise HTTPException(409, "The reviewed configuration is incomplete")
            filename = sanitize_output_filename(output_filename, workflow)
            acknowledged_codes = self._validate_acknowledgments(job, acknowledged)
            if acknowledged_codes != job.reviewed_issue_codes:
                raise HTTPException(409, "Warning acknowledgments changed after review")
            staged = self._staged_path(job)
            if not staged.is_file() or sha256_file(staged) != job.staged_artifact_sha256:
                raise HTTPException(409, "The reviewed artifact is unavailable or changed")
            if sha256_file(self.source_path(job_id)) != job.input_sha256:
                raise HTTPException(409, "The uploaded source changed after ingestion")
            self._set_reservation_locked(job_id, staged.stat().st_size + 1024 * 1024, connection)
            job.status = JobStatus.processing
            job.progress = JobProgress(
                phase="Queued for output generation", percent=5, rows_processed=analysis.row_count
            )
            job.error = job.error_code = None
            self._save_locked(
                job,
                connection,
                task="finalize",
                task_payload={"output_filename": filename, "acknowledged": acknowledged_codes},
                preserve_task=False,
            )
        self._wake.set()
        return job

    def _claim_task(self) -> tuple[str, str, dict, str] | None:
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT job_id,task,task_payload FROM jobs WHERE task IS NOT NULL "
                "AND (lease_until IS NULL OR lease_until<?) ORDER BY updated_at LIMIT 1",
                (now,),
            ).fetchone()
            if not row:
                return None
            try:
                payload = json.loads(row["task_payload"] or "{}")
            except (TypeError, json.JSONDecodeError):
                job = self._load_locked(row["job_id"], connection)
                job.status = JobStatus.failed
                job.error = "The queued operation could not be restored. Retry with a new job."
                job.error_code = "invalid_task_payload"
                self._set_reservation_locked(job.job_id, 0, connection)
                self._save_locked(job, connection, preserve_task=False)
                log_event("job_task_rejected", job_id=job.job_id, error_code=job.error_code)
                return None
            lease_token = self._assign_lease_locked(row["job_id"], connection)
            return row["job_id"], row["task"], payload, lease_token

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                claimed = self._claim_task()
            except Exception:
                self._worker_failures += 1
                LOGGER.exception('{"event":"job_claim_failed"}')
                self._wake.wait(1)
                self._wake.clear()
                continue
            if not claimed:
                self._wake.wait(1)
                self._wake.clear()
                continue
            job_id, task, payload, lease_token = claimed
            log_event("job_task_started", job_id=job_id, task=task)
            try:
                with self._lease_heartbeat(job_id, lease_token):
                    if self._cancelled(job_id):
                        self._delete_job(job_id)
                    elif task == "analyze":
                        self._run_analysis(job_id, payload["filename"], lease_token)
                    elif task == "prepare_review":
                        self._run_prepare_review(job_id, payload, lease_token)
                    elif task == "finalize":
                        self._run_finalize(job_id, payload, lease_token)
                    else:
                        raise RuntimeError(f"Unknown task {task}")
            except Exception as exc:
                self._worker_failures += 1
                self._mark_worker_failure(job_id, exc, lease_token)

    def _cancelled(self, job_id: str) -> bool:
        with self._connect() as connection:
            row = connection.execute("SELECT cancel_requested FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            return not row or bool(row[0])

    def _run_analysis(self, job_id: str, filename: str, lease_token: str) -> None:
        with self._lock, self._connect() as connection:
            if not self._lease_owned_locked(job_id, lease_token, connection):
                return
            job = self._load_locked(job_id, connection)
            job.progress = JobProgress(
                phase="Analyzing CSV", percent=35, bytes_processed=self.source_path(job_id).stat().st_size
            )
            self._save_locked(job, connection)
        analysis = analyze_csv(self.source_path(job_id), filename)
        if self._cancelled(job_id):
            self._delete_job(job_id)
            return
        with self._lock, self._connect() as connection:
            if not self._lease_owned_locked(job_id, lease_token, connection):
                return
            job = self._load_locked(job_id, connection)
            job.analysis = analysis
            job.workflow = None
            job.mapping = None
            job.pleading_settings = None
            blocked = any(issue.severity in {"error", "fatal"} for issue in analysis.issues)
            job.status = JobStatus.failed if blocked else JobStatus.needs_configuration
            job.error = "This CSV is structurally invalid and cannot be processed." if blocked else None
            job.error_code = "invalid_csv" if blocked else None
            job.progress = JobProgress(
                phase="Analysis complete",
                percent=100,
                bytes_processed=analysis.size_bytes,
                rows_processed=analysis.row_count,
            )
            self._save_locked(job, connection, preserve_task=False)
        log_event("job_analysis_finished", job_id=job_id, status=job.status.value)

    def _run_prepare_review(self, job_id: str, payload: dict, lease_token: str) -> None:
        with self._lock, self._connect() as connection:
            if not self._lease_owned_locked(job_id, lease_token, connection):
                return
            job = self._load_locked(job_id, connection)
            analysis = job.analysis
            workflow = job.workflow
            if analysis is None or workflow is None:
                raise RuntimeError("The review configuration is incomplete")
            job.progress = JobProgress(
                phase="Building exact review artifact", percent=45, rows_processed=analysis.row_count
            )
            self._save_locked(job, connection)
        source = self.source_path(job_id)
        review_input_sha256 = sha256_file(source)
        if review_input_sha256 != job.input_sha256:
            raise RuntimeError("The uploaded source changed after ingestion")
        staged = self._staged_path(job)
        temporary = staged.with_suffix(staged.suffix + ".partial")
        stats = write_output(
            temporary,
            source,
            analysis,
            workflow,
            job.mapping,
            len(payload["acknowledged"]),
            job.pleading_settings,
            self.max_work_bytes,
        )
        if self._cancelled(job_id):
            temporary.unlink(missing_ok=True)
            self._delete_job(job_id)
            return
        artifact_sha256 = sha256_file(temporary)
        token_material = json.dumps(
            {
                "job_id": job_id,
                "input_sha256": review_input_sha256,
                "artifact_sha256": artifact_sha256,
                "configuration_revision": job.configuration_revision,
                "acknowledged": payload["acknowledged"],
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        review_token = hashlib.sha256(token_material).hexdigest()
        reviewed_at = datetime.now(UTC).isoformat()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if not self._lease_owned_locked(job_id, lease_token, connection):
                temporary.unlink(missing_ok=True)
                return
            temporary.replace(staged)
            job = self._load_locked(job_id, connection)
            job.review_stats = stats
            job.reviewed_issue_codes = payload["acknowledged"]
            job.reviewed_configuration_revision = job.configuration_revision
            job.review_token = review_token
            job.staged_artifact_sha256 = artifact_sha256
            job.staged_at = reviewed_at
            job.status = JobStatus.ready_for_review
            job.progress = JobProgress(
                phase="Exact review artifact ready", percent=100, rows_processed=stats.output_rows
            )
            self._set_reservation_locked(job_id, 0, connection)
            self._save_locked(job, connection, preserve_task=False)
        log_event("job_review_prepared", job_id=job_id, output_rows=stats.output_rows)

    def _run_finalize(self, job_id: str, payload: dict, lease_token: str) -> None:
        with self._lock, self._connect() as connection:
            if not self._lease_owned_locked(job_id, lease_token, connection):
                return
            job = self._load_locked(job_id, connection)
            analysis = job.analysis
            workflow = job.workflow
            if analysis is None or workflow is None:
                raise RuntimeError("The reviewed configuration is incomplete")
            job.progress = JobProgress(
                phase="Packaging reviewed output", percent=70, rows_processed=analysis.row_count
            )
            self._save_locked(job, connection)
        output = self._directory(job_id) / ("output.txt" if job.workflow == "rfp_ranges" else "output.csv")
        staged = self._staged_path(job)
        stats = job.review_stats
        if not stats or not staged.is_file() or sha256_file(staged) != job.staged_artifact_sha256:
            raise RuntimeError("The reviewed artifact is unavailable or changed")
        if self._cancelled(job_id):
            self._delete_job(job_id)
            return
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if not self._lease_owned_locked(job_id, lease_token, connection):
                return
            staged.replace(output)
            stats.output_size_bytes = output.stat().st_size
            completed_at = datetime.now(UTC).isoformat()
            receipt = self._build_receipt(job, payload["output_filename"], payload["acknowledged"], stats, completed_at)
            directory = self._directory(job_id)
            (directory / "receipt.json").write_text(receipt.model_dump_json(indent=2) + "\n", encoding="utf-8")
            (directory / "receipt.txt").write_text(render_receipt_text(receipt), encoding="utf-8", newline="")
            build_evidence_package(directory, output, payload["output_filename"])
            job = self._load_locked(job_id, connection)
            job.output_filename = payload["output_filename"]
            job.output_stats = stats
            job.status = JobStatus.complete
            job.progress = JobProgress(phase="Complete", percent=100, rows_processed=stats.output_rows)
            self._set_reservation_locked(job_id, 0, connection)
            self._save_locked(job, connection, preserve_task=False)
        log_event("job_finalization_finished", job_id=job_id, output_rows=stats.output_rows)

    def _build_receipt(self, job: JobView, filename: str, acknowledged: list[str], stats, completed_at: str) -> Receipt:
        analysis = job.analysis
        workflow = job.workflow
        if analysis is None or workflow is None:
            raise RuntimeError("The completed job configuration is incomplete")
        source = self.source_path(job.job_id)
        output = self._directory(job.job_id) / ("output.txt" if job.workflow == "rfp_ranges" else "output.csv")
        return Receipt(
            app_version=APP_VERSION,
            build_id=BUILD_ID,
            source_revision=SOURCE_REVISION,
            image_digest=IMAGE_DIGEST,
            job_id=job.job_id,
            created_at=job.created_at,
            uploaded_at=job.uploaded_at or job.created_at,
            reviewed_at=job.staged_at or completed_at,
            completed_at=completed_at,
            expires_at=job.expires_at,
            input_filename=analysis.filename,
            input_size_bytes=analysis.size_bytes,
            input_sha256=job.input_sha256 or sha256_file(source),
            review_input_sha256=sha256_file(source),
            output_filename=filename,
            output_size_bytes=output.stat().st_size,
            output_sha256=sha256_file(output),
            staged_output_sha256=job.staged_artifact_sha256 or sha256_file(output),
            configuration_revision=job.configuration_revision,
            workflow=workflow,
            platform=analysis.platform,
            platform_confidence=analysis.platform_confidence,
            mapping=job.mapping,
            pleading_settings=job.pleading_settings,
            issue_counts={issue.code: issue.count for issue in analysis.issues},
            acknowledged_issue_codes=acknowledged,
            personal_data_counts={finding.category: finding.count for finding in analysis.personal_data_findings},
            output_stats=stats,
        )

    def _mark_worker_failure(self, job_id: str, error: Exception, lease_token: str | None = None) -> None:
        with self._lock, self._connect() as connection:
            if lease_token and not self._lease_owned_locked(job_id, lease_token, connection):
                return
            try:
                job = self._load_locked(job_id, connection)
            except HTTPException:
                return
            job.status = JobStatus.failed
            job.error = "Processing could not be completed. You may retry with a new job."
            job.error_code = (
                "resource_limit_exceeded"
                if isinstance(error, (ResourceLimitError, ProcessingLimitError))
                else "processing_failed"
            )
            for path in self._directory(job_id).glob("*.partial"):
                path.unlink(missing_ok=True)
            self._set_reservation_locked(job_id, 0, connection)
            self._save_locked(job, connection, preserve_task=False)
        LOGGER.exception(
            json.dumps(
                {"event": "job_task_failed", "job_id": job_id, "error_code": job.error_code},
                separators=(",", ":"),
                sort_keys=True,
            ),
            exc_info=(type(error), error, error.__traceback__),
        )

    def output_path(self, job_id: str) -> tuple[Path, JobView]:
        job = self.get(job_id)
        path = self._directory(job_id) / ("output.txt" if job.workflow == "rfp_ranges" else "output.csv")
        if job.status != JobStatus.complete or not path.exists():
            raise HTTPException(409, "The output is not ready")
        return path, job

    def preview(self, job_id: str, limit: int) -> Preview:
        job = self.get(job_id)
        if job.status not in {JobStatus.ready_for_review, JobStatus.complete} or not job.review_stats:
            raise HTTPException(409, "The exact review artifact is not ready")
        path = self._staged_path(job) if job.status == JobStatus.ready_for_review else self.output_path(job_id)[0]
        if not job.staged_artifact_sha256 or not job.review_token:
            raise HTTPException(409, "The exact review artifact is incomplete")
        if job.workflow is None:
            raise HTTPException(409, "The reviewed workflow is unavailable")
        return build_artifact_preview(
            path,
            job.workflow,
            job.review_stats,
            limit=limit,
            artifact_sha256=job.staged_artifact_sha256,
            configuration_revision=job.configuration_revision,
            review_token=job.review_token,
        )

    def receipt_path(self, job_id: str, kind: str) -> tuple[Path, JobView]:
        job = self.get(job_id)
        path = self._directory(job_id) / f"receipt.{kind}"
        if job.status != JobStatus.complete or not path.exists():
            raise HTTPException(409, "The processing receipt is not ready")
        return path, job

    def evidence_path(self, job_id: str) -> tuple[Path, JobView]:
        job = self.get(job_id)
        path = self._directory(job_id) / "evidence-package.zip"
        if job.status != JobStatus.complete or not path.exists():
            raise HTTPException(409, "The evidence package is not ready")
        return path, job

    def delete(self, job_id: str) -> bool:
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            job = self._load_locked(job_id, connection)
            if job.status in {
                JobStatus.uploading,
                JobStatus.analyzing,
                JobStatus.preparing_review,
                JobStatus.processing,
            }:
                job.cancel_requested = True
                connection.execute(
                    "UPDATE jobs SET cancel_requested=1,delete_requested=1,delete_error=NULL WHERE job_id=?",
                    (job_id,),
                )
                return True
            deleted = self._delete_locked(job_id, connection)
            if deleted:
                log_event("job_deleted", job_id=job_id)
            return not deleted

    def _delete_job(self, job_id: str) -> bool:
        with self._lock, self._connect() as connection:
            return self._delete_locked(job_id, connection)

    def _delete_locked(self, job_id: str, connection: sqlite3.Connection) -> bool:
        directory = self._directory(job_id, require_exists=False)
        if directory.is_dir():
            try:
                shutil.rmtree(directory)
            except OSError as exc:
                self._mark_deletion_pending_locked(job_id, connection, type(exc).__name__)
                return False
        if directory.exists():
            self._mark_deletion_pending_locked(job_id, connection, "directory_remains")
            return False
        connection.execute("DELETE FROM jobs WHERE job_id=?", (job_id,))
        return True

    def _mark_deletion_pending_locked(self, job_id: str, connection: sqlite3.Connection, error_code: str) -> None:
        row = connection.execute("SELECT payload FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if row:
            with suppress(ValueError):
                job = JobView.model_validate_json(row["payload"])
                job.status = JobStatus.expired
                job.cancel_requested = True
                job.error = "Secure deletion is pending and will be retried automatically."
                job.error_code = "deletion_pending"
                self._save_locked(job, connection, preserve_task=False)
        connection.execute(
            "UPDATE jobs SET task=NULL,lease_until=NULL,lease_owner=NULL,lease_token=NULL,"
            "last_heartbeat=NULL,reserved_bytes=0,cancel_requested=1,delete_requested=1,delete_error=? "
            "WHERE job_id=?",
            (error_code, job_id),
        )

    def _remove_outputs(self, job_id: str) -> None:
        for name in (
            "staged.csv",
            "staged.txt",
            "output.csv",
            "output.txt",
            "receipt.json",
            "receipt.txt",
            "evidence-manifest.json",
            "evidence-package.zip",
        ):
            (self._directory(job_id) / name).unlink(missing_ok=True)

    def cleanup(self) -> int:
        removed = 0
        now = datetime.now(UTC)
        now_timestamp = now.timestamp()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute("SELECT job_id,payload,task,lease_until,delete_requested FROM jobs").fetchall()
            for row in rows:
                live_lease = bool(row["lease_until"] and row["lease_until"] > now_timestamp)
                if row["delete_requested"]:
                    if live_lease:
                        continue
                    if self._delete_locked(row["job_id"], connection):
                        removed += 1
                    continue
                try:
                    job = JobView.model_validate_json(row["payload"])
                    expired = datetime.fromisoformat(job.expires_at) <= now
                except ValueError:
                    expired = True
                    job = None
                if job and not live_lease:
                    self._repair_taskless_active_locked(job, row["task"], connection)
                if not expired:
                    continue
                active_status = bool(
                    job
                    and job.status
                    in {JobStatus.uploading, JobStatus.analyzing, JobStatus.preparing_review, JobStatus.processing}
                )
                if active_status and live_lease:
                    connection.execute(
                        "UPDATE jobs SET cancel_requested=1,delete_requested=1 WHERE job_id=?",
                        (row["job_id"],),
                    )
                else:
                    if self._delete_locked(row["job_id"], connection):
                        removed += 1
        return removed


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def render_receipt_text(receipt: Receipt) -> str:
    lines = [
        "Production Tool Processing Receipt",
        f"Receipt schema: {receipt.schema_version}",
        f"Application version: {receipt.app_version}",
        f"Build ID: {receipt.build_id}",
        f"Source revision: {receipt.source_revision}",
        f"Image digest: {receipt.image_digest}",
        f"Job: {receipt.job_id}",
        f"Created: {receipt.created_at}",
        f"Uploaded: {receipt.uploaded_at}",
        f"Reviewed: {receipt.reviewed_at}",
        f"Completed: {receipt.completed_at}",
        f"Expires: {receipt.expires_at}",
        "",
        f"Input: {receipt.input_filename}",
        f"Input bytes: {receipt.input_size_bytes}",
        f"Input SHA-256: {receipt.input_sha256}",
        f"Review input SHA-256: {receipt.review_input_sha256}",
        f"Output: {receipt.output_filename}",
        f"Output bytes: {receipt.output_size_bytes}",
        f"Output SHA-256: {receipt.output_sha256}",
        f"Staged output SHA-256: {receipt.staged_output_sha256}",
        "",
        f"Workflow: {receipt.workflow}",
        f"Configuration revision: {receipt.configuration_revision}",
        f"Mapping: {receipt.mapping.model_dump_json() if receipt.mapping else 'None'}",
        f"Pleading settings: {receipt.pleading_settings.model_dump_json() if receipt.pleading_settings else 'None'}",
        f"Detected platform: {receipt.platform} ({receipt.platform_confidence}% confidence)",
        f"Input rows: {receipt.output_stats.input_rows}",
        f"Output rows: {receipt.output_stats.output_rows}",
        f"Skipped rows: {receipt.output_stats.skipped_rows}",
        f"Formula escapes: {receipt.output_stats.formula_escapes}",
        f"Acknowledged warnings: {', '.join(receipt.acknowledged_issue_codes) or 'None'}",
        f"Issue counts: {json.dumps(receipt.issue_counts, sort_keys=True)}",
        f"Personal-data advisory counts: {json.dumps(receipt.personal_data_counts, sort_keys=True)}",
    ]
    return "\r\n".join(lines) + "\r\n"


def sanitize_output_filename(value: str, workflow: str) -> str:
    name = value.strip()
    extension = ".txt" if workflow == "rfp_ranges" else ".csv"
    for known_extension in (".csv", ".txt"):
        if name.casefold().endswith(known_extension):
            name = name[: -len(known_extension)]
            break
    stem = name.rstrip(". ")
    final_name = f"{stem}{extension}"
    if not stem or len(final_name) > 124 or not SAFE_FILENAME.fullmatch(final_name):
        raise HTTPException(422, "Enter a valid filename of 120 characters or fewer")
    if stem.upper() in WINDOWS_RESERVED:
        raise HTTPException(422, "That filename is reserved")
    return final_name
