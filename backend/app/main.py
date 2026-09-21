# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""FastAPI routes and application lifecycle for the Production Tool service."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from .jobs import JobStore
from .models import (
    Capabilities,
    FinalizeRequest,
    JobCreated,
    JobView,
    MappingConfig,
    PleadingSettings,
    Preview,
    ReviewRequest,
    WorkflowUpdate,
)
from .release import APP_VERSION

store = JobStore()


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(300)
        store.cleanup()


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.start()
    task = asyncio.create_task(cleanup_loop())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    store.stop()


app = FastAPI(title="Production Tool API", version=APP_VERSION, lifespan=lifespan)


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response


@app.get("/healthz")
def health() -> dict[str, int | str]:
    return store.health()


@app.get("/api/healthz")
def api_health() -> dict[str, int | str]:
    return store.health()


@app.get("/api/v1/capabilities", response_model=Capabilities)
def capabilities() -> Capabilities:
    return store.capabilities()


@app.post("/api/v1/jobs", response_model=JobCreated, status_code=201)
def create_job() -> JobCreated:
    job = store.create()
    return JobCreated(job_id=job.job_id, expires_at=job.expires_at)


@app.put("/api/v1/jobs/{job_id}/source", response_model=JobView, status_code=202)
async def upload_source(job_id: str, file: Annotated[UploadFile, File()]) -> JobView:
    return await store.upload(job_id, file)


@app.get("/api/v1/jobs/{job_id}", response_model=JobView)
def get_job(job_id: str) -> JobView:
    return store.get(job_id)


@app.put("/api/v1/jobs/{job_id}/workflow", response_model=JobView)
def set_workflow(job_id: str, payload: WorkflowUpdate) -> JobView:
    return store.set_workflow(job_id, payload.workflow)


@app.put("/api/v1/jobs/{job_id}/mapping", response_model=JobView)
def set_mapping(job_id: str, payload: MappingConfig) -> JobView:
    return store.set_mapping(job_id, payload)


@app.put("/api/v1/jobs/{job_id}/pleading-settings", response_model=JobView)
def set_pleading_settings(job_id: str, payload: PleadingSettings) -> JobView:
    return store.set_pleading_settings(job_id, payload)


@app.post("/api/v1/jobs/{job_id}/review", response_model=JobView, status_code=202)
def mark_review_ready(job_id: str, payload: ReviewRequest | None = None) -> JobView:
    return store.mark_review_ready(job_id, payload.acknowledged_issue_codes if payload else [])


@app.get("/api/v1/jobs/{job_id}/preview", response_model=Preview, response_model_exclude_none=True)
def preview(job_id: str, limit: int = 5) -> Preview:
    if limit < 1 or limit > 5:
        raise HTTPException(422, "Preview limit must be between 1 and 5")
    return store.preview(job_id, limit)


@app.post("/api/v1/jobs/{job_id}/finalize", response_model=JobView, status_code=202)
def finalize(job_id: str, payload: FinalizeRequest) -> JobView:
    return store.enqueue_finalize(
        job_id, payload.output_filename, payload.acknowledged_issue_codes, payload.review_token
    )


@app.get("/api/v1/jobs/{job_id}/download", response_class=FileResponse)
def download(job_id: str) -> FileResponse:
    path, job = store.output_path(job_id)
    media_type = "text/plain; charset=utf-8" if path.suffix == ".txt" else "text/csv; charset=utf-8"
    return FileResponse(path, media_type=media_type, filename=job.output_filename)


@app.get("/api/v1/jobs/{job_id}/receipt.json", response_class=FileResponse)
def download_json_receipt(job_id: str) -> FileResponse:
    path, job = store.receipt_path(job_id, "json")
    filename = Path(job.output_filename or "production-output").stem
    return FileResponse(path, media_type="application/json", filename=f"{filename}_receipt.json")


@app.get("/api/v1/jobs/{job_id}/receipt.txt", response_class=FileResponse)
def download_text_receipt(job_id: str) -> FileResponse:
    path, job = store.receipt_path(job_id, "txt")
    filename = Path(job.output_filename or "production-output").stem
    return FileResponse(
        path, media_type="text/plain; charset=utf-8", filename=f"{filename}_receipt.txt"
    )


@app.get("/api/v1/jobs/{job_id}/evidence.zip", response_class=FileResponse)
def download_evidence_package(job_id: str) -> FileResponse:
    path, job = store.evidence_path(job_id)
    filename = Path(job.output_filename or "production-output").stem
    return FileResponse(path, media_type="application/zip", filename=f"{filename}_evidence.zip")


@app.delete("/api/v1/jobs/{job_id}", status_code=204, response_class=Response)
def delete_job(job_id: str) -> Response:
    pending = store.delete(job_id)
    return Response(status_code=202 if pending else 204)
