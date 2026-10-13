# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""HTTP entry point checks for health and unsupported multipart requests."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import main


def test_both_health_endpoints_return_store_status(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = {"status": "ok", "workers_alive": 2}
    monkeypatch.setattr(main.store, "health", lambda: expected)
    assert main.health() == expected
    assert main.api_health() == expected


def test_cleanup_loop_runs_after_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    intervals: list[int] = []
    cleaned: list[bool] = []

    async def one_interval(seconds: int) -> None:
        intervals.append(seconds)
        if len(intervals) == 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(main.asyncio, "sleep", one_interval)
    monkeypatch.setattr(main.store, "cleanup", lambda: cleaned.append(True))
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main.cleanup_loop())
    assert intervals == [300, 300]
    assert cleaned == [True]


@pytest.mark.parametrize("headers", [
    [(b"content-type", b"multipart/form-data; boundary=sample")],
    [(b"content-type", b"multipart/form-data; boundary=sample"), (b"content-length", b"0")],
])
def test_multipart_is_rejected_before_reading_body(headers: list[tuple[bytes, bytes]]) -> None:
    scope = {"type": "http", "method": "PUT", "path": "/api/v1/jobs/job/source", "headers": headers}

    async def empty_body():
        return {"type": "http.request", "body": b"", "more_body": False}

    with pytest.raises(HTTPException) as rejected:
        asyncio.run(main.upload_source("job", Request(scope, receive=empty_body)))
    assert rejected.value.status_code == 415
