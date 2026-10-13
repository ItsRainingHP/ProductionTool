# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Large upload through the container's streaming proxy and a real uvicorn API."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def _json_request(url: str, *, method: str = "GET", body: bytes | None = None, headers: dict[str, str] | None = None):
    with urlopen(Request(url, data=body, headers=headers or {}, method=method), timeout=60) as response:
        return response.status, json.load(response)


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required for the container proxy")
def test_large_csv_streams_through_proxy_to_api(tmp_path: Path) -> None:
    api_port = _free_port()
    proxy_port = _free_port()
    while proxy_port == api_port:
        proxy_port = _free_port()
    environment = os.environ.copy()
    environment["JOB_DATA_DIR"] = str(tmp_path / "jobs")
    environment["MAX_UPLOAD_BYTES"] = str(20 * 1024 * 1024)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    api = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(api_port)],
        cwd=ROOT / "backend", env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=flags,
    )
    proxy_environment = {
        **environment, "PORT": str(proxy_port), "API_PORT": str(api_port), "WEB_PORT": "1",
        "PROXY_HOST": "127.0.0.1",
    }
    proxy = subprocess.Popen(
        [shutil.which("node") or "node", str(ROOT / "deploy" / "http-proxy.cjs")],
        cwd=ROOT, env=proxy_environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=flags,
    )
    try:
        base = f"http://127.0.0.1:{proxy_port}"
        deadline = time.monotonic() + 20
        while True:
            try:
                status, _ = _json_request(base + "/api/healthz")
                if status == 200:
                    break
            except (URLError, TimeoutError) as exc:
                if hasattr(exc, "close"):
                    exc.close()
            if time.monotonic() > deadline:
                raise AssertionError(f"Proxy/API did not start: {proxy.poll()}, {api.poll()}")
            time.sleep(0.1)

        _, created = _json_request(base + "/api/v1/jobs", method="POST", body=b"{}")
        job_id = created["job_id"]
        source = (
            b'Begin Bates,End Bates,Tag: RFP 01,Notes\nABC0001,ABC0002,TRUE,"'
            + b"x" * (11 * 1024 * 1024) + b'"\n'
        )
        status, uploaded = _json_request(
            base + f"/api/v1/jobs/{job_id}/source", method="PUT", body=source,
            headers={"Content-Type": "text/csv", "X-File-Name": "large.csv"},
        )
        assert status == 202
        assert uploaded["status"] in {"analyzing", "needs_configuration"}
        deadline = time.monotonic() + 90
        while True:
            _, job = _json_request(base + f"/api/v1/jobs/{job_id}")
            if job["status"] in {"needs_configuration", "failed"}:
                break
            if time.monotonic() > deadline:
                raise AssertionError("Large upload was accepted but analysis did not finish")
            time.sleep(0.2)
        assert job["status"] == "needs_configuration", job.get("error")
        assert job["analysis"]["row_count"] == 1
        assert job["analysis"]["request_count"] == 1
    finally:
        for process in (proxy, api):
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
