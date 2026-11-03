# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Release availability, registry metadata, and failure-isolation coverage."""

from __future__ import annotations

import io
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from email.message import Message
from http.client import HTTPException
from unittest.mock import Mock
from urllib.error import URLError
from urllib.request import Request

import pytest
from fastapi.testclient import TestClient

from app import main, system_status
from app.models import SystemStatus
from app.system_status import SystemStatusChecker


def settled(checker):
    checker.get()
    with checker._lock:
        worker = checker._worker
    if worker is not None:
        worker.join(timeout=3)
        assert not worker.is_alive()
    return checker.get()


DIGEST = "sha256:" + "a" * 64
CONFIG_DIGEST = "sha256:" + "b" * 64


def test_registry_reads_only_platform_metadata_and_uses_app_version(monkeypatch):
    read = Mock(side_effect=[
        {"token": "anonymous-pull-token"},
        {"manifests": [None, {"platform": None},
                       {"platform": {"os": "unknown", "architecture": "unknown"}},
                       {"platform": {"os": "linux", "architecture": "amd64"}, "digest": DIGEST}]},
        {"config": {"digest": CONFIG_DIGEST}, "layers": [{"digest": "never-download"}]},
        {"config": {"Env": [None, "OTHER=value", "APP_VERSION=2.0.10"],
                    "Labels": {"org.opencontainers.image.version": "main"}}},
    ])
    monkeypatch.setattr(system_status, "_read_json", read)
    assert system_status.published_version() == "2.0.10"
    assert [call.args[0] for call in read.call_args_list] == [
        system_status.TOKEN_URL, f"{system_status.REGISTRY}/manifests/latest",
        f"{system_status.REGISTRY}/manifests/{DIGEST}", f"{system_status.REGISTRY}/blobs/{CONFIG_DIGEST}",
    ]
    assert all(call.args[1] == "anonymous-pull-token" for call in read.call_args_list[1:])


def test_single_manifest_and_access_token_are_supported(monkeypatch):
    monkeypatch.setattr(system_status, "_read_json", Mock(side_effect=[
        {"access_token": "anonymous"}, {"config": {"digest": CONFIG_DIGEST}},
        {"config": {"Env": ["APP_VERSION=3.1.0"]}},
    ]))
    assert system_status.published_version() == "3.1.0"


@pytest.mark.parametrize("responses", [
    [{}], [{"token": 1}], [{"token": ""}],
    [{"token": "t"}, {"manifests": None}],
    [{"token": "t"}, {"manifests": []}],
    [{"token": "t"}, {"manifests": [{"platform": {"os": "linux", "architecture": "arm64"}}]}],
    [{"token": "t"}, {"manifests": [{"platform": {"os": "linux", "architecture": "amd64"},
                                     "digest": "../../bad"}]}],
    [{"token": "t"}, {}], [{"token": "t"}, {"config": []}],
    [{"token": "t"}, {"config": {"digest": None}}],
    [{"token": "t"}, {"config": {"digest": "https://unexpected-host/config"}}],
    [{"token": "t"}, {"config": {"digest": CONFIG_DIGEST}}, {}],
    [{"token": "t"}, {"config": {"digest": CONFIG_DIGEST}}, {"config": {"Env": "bad"}}],
    [{"token": "t"}, {"config": {"digest": CONFIG_DIGEST}}, {"config": {"Env": []}}],
    [{"token": "t"}, {"config": {"digest": CONFIG_DIGEST}}, {"config": {"Env": ["APP_VERSION=main"]}}],
])
def test_invalid_registry_metadata_is_rejected(monkeypatch, responses):
    monkeypatch.setattr(system_status, "_read_json", Mock(side_effect=responses))
    with pytest.raises(ValueError):
        system_status.published_version()


@pytest.mark.parametrize("body", [b"[]", b"null", b"invalid-json", b"x" * (system_status.MAX_METADATA_BYTES + 1)],
                         ids=["array", "null", "invalid-json", "oversized"])
def test_metadata_reader_rejects_invalid_or_oversized_responses(monkeypatch, body):
    opener = Mock()
    opener.open.return_value = io.BytesIO(body)
    monkeypatch.setattr(system_status, "build_opener", Mock(return_value=opener))
    with pytest.raises(ValueError):
        system_status._read_json(system_status.TOKEN_URL)


@pytest.mark.parametrize("token", [None, "pull-token"])
def test_metadata_reader_bounds_requests_and_parses_json(monkeypatch, token):
    opener = Mock()
    opener.open.return_value = io.BytesIO(json.dumps({"config": {}}).encode())
    monkeypatch.setattr(system_status, "build_opener", Mock(return_value=opener))
    assert system_status._read_json(system_status.TOKEN_URL, token) == {"config": {}}
    request = opener.open.call_args.args[0]
    assert opener.open.call_args.kwargs == {"timeout": 5}
    assert request.get_header("Authorization") == (f"Bearer {token}" if token else None)
    assert "application/vnd.oci.image.index.v1+json" in request.get_header("Accept")


@pytest.mark.parametrize("destination,expected_token", [
    ("https://registry-1.docker.io/other", "Bearer token"),
    ("https://metadata-cdn.example/config", None),
])
def test_redirects_strip_credentials_on_other_hosts(destination, expected_token):
    request = Request(f"{system_status.REGISTRY}/blobs/{CONFIG_DIGEST}", headers={"Authorization": "Bearer token"})
    redirected = system_status.MetadataRedirectHandler().redirect_request(
        request, None, 302, "Found", Message(), destination,
    )
    assert redirected.get_header("Authorization") == expected_token


def test_redirects_require_https():
    with pytest.raises(ValueError, match="HTTPS"):
        system_status.MetadataRedirectHandler().redirect_request(
            Request(system_status.TOKEN_URL), None, 302, "Found", Message(), "http://example.com/config",
        )


@pytest.mark.parametrize("current,latest,expected", [
    ("2.0.5", "2.0.6", True), ("2.0.5", "2.0.5", False), ("2.0.5", "2.0.4", False),
    ("2.0.9", "2.0.10", True), ("2.0.10", "2.0.9", False), ("2.9.9", "2.10.0", True),
    ("2.99.99", "3.0.0", True), ("development", "2.0.6", False),
])
def test_numeric_versions_determine_availability(monkeypatch, current, latest, expected):
    monkeypatch.setattr(system_status, "published_version", Mock(return_value=latest))
    assert settled(SystemStatusChecker(current)).model_dump() == {
        "current_version": current, "latest_version": latest, "update_available": expected,
    }


@pytest.mark.parametrize("version", ["main", "v2.0.5", "2.0", "2.0.5-rc.1", "2.0.5+build", "02.0.5", "2.-1.0", ""])
def test_only_stable_canonical_versions_are_compared(version):
    assert system_status._stable_version(version) is None


def test_success_cache_expires_after_one_hour(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(system_status.time, "monotonic", lambda: now[0])
    fetch = Mock(side_effect=["2.0.5", "2.0.6"])
    monkeypatch.setattr(system_status, "published_version", fetch)
    checker = SystemStatusChecker("2.0.5")
    assert not settled(checker).update_available
    now[0] += 3599
    assert not settled(checker).update_available
    assert fetch.call_count == 1
    now[0] += 1
    assert settled(checker).update_available
    assert fetch.call_count == 2


@pytest.mark.parametrize("error", [URLError("offline"), TimeoutError(), OSError(), ValueError(), HTTPException()])
def test_first_failure_defaults_to_ready_and_retries_after_five_minutes(monkeypatch, error):
    now = [10.0]
    monkeypatch.setattr(system_status.time, "monotonic", lambda: now[0])
    fetch = Mock(side_effect=[error, "2.0.6"])
    monkeypatch.setattr(system_status, "published_version", fetch)
    checker = SystemStatusChecker("2.0.5")
    assert settled(checker).latest_version is None
    now[0] += 299
    assert not settled(checker).update_available
    assert fetch.call_count == 1
    now[0] += 1
    assert settled(checker).update_available


def test_failed_refresh_preserves_last_confirmed_update(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(system_status.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(system_status, "published_version", Mock(side_effect=["2.0.6", TimeoutError()]))
    checker = SystemStatusChecker("2.0.5")
    first = settled(checker)
    now[0] += 3600
    assert settled(checker) == first
    assert first.update_available


def test_concurrent_clients_share_one_registry_check(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def fetch():
        started.set()
        assert release.wait(timeout=5)
        return "2.0.6"

    fetch_mock = Mock(side_effect=fetch)
    monkeypatch.setattr(system_status, "published_version", fetch_mock)
    checker = SystemStatusChecker("2.0.5")
    with ThreadPoolExecutor(max_workers=6) as executor:
        pending = [executor.submit(settled, checker) for _ in range(6)]
        assert started.wait(timeout=5)
        release.set()
        assert all(future.result(timeout=5).update_available for future in pending)
    assert fetch_mock.call_count == 1


def test_status_endpoint_has_typed_payload_and_no_store_headers(monkeypatch):
    checker = SystemStatusChecker("2.0.5")
    monkeypatch.setattr(main, "status_checker", checker)
    monkeypatch.setattr(system_status, "published_version", Mock(return_value="2.0.6"))
    settled(checker)
    response = TestClient(main.app).get("/api/v1/system-status")
    assert response.status_code == 200
    assert response.json() == SystemStatus(
        current_version="2.0.5", latest_version="2.0.6", update_available=True,
    ).model_dump()
    assert response.headers["cache-control"] == "no-store"


def test_update_failure_does_not_change_service_health(monkeypatch):
    monkeypatch.setattr(main, "status_checker", SystemStatusChecker("2.0.5"))
    monkeypatch.setattr(system_status, "published_version", Mock(side_effect=TimeoutError()))
    health = Mock(return_value={"status": "ok"})
    monkeypatch.setattr(main.store, "health", health)
    client = TestClient(main.app)
    assert client.get("/api/v1/system-status").json()["update_available"] is False
    assert client.get("/api/healthz").json() == {"status": "ok"}


def test_slow_refresh_returns_cache_without_waiting(monkeypatch):
    release = threading.Event()
    started = threading.Event()

    def fetch():
        started.set()
        assert release.wait(5)
        return "2.0.6"

    monkeypatch.setattr(system_status, "published_version", fetch)
    checker = SystemStatusChecker("2.0.5")
    try:
        assert checker.get().latest_version is None
        assert started.wait(2)
        with ThreadPoolExecutor(max_workers=40) as executor:
            futures = [executor.submit(checker.get) for _ in range(40)]
            assert all(future.result(timeout=2).latest_version is None for future in futures)
    finally:
        release.set()
        checker.stop()


def test_blocked_registry_does_not_block_api_routes(monkeypatch):
    import asyncio

    import httpx2

    release = threading.Event()
    started = threading.Event()
    calls = []

    def fetch():
        calls.append(True)
        started.set()
        assert release.wait(10)
        return "2.0.6"

    monkeypatch.setattr(main.store, "health", lambda: {"status": "ok"})
    checker = SystemStatusChecker("2.0.5")
    monkeypatch.setattr(main, "status_checker", checker)
    monkeypatch.setattr(system_status, "published_version", fetch)

    async def exercise():
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=main.app), base_url="http://test") as client:
            first = await client.get("/api/v1/system-status")
            assert first.json()["latest_version"] is None
            assert started.wait(2)
            responses = await asyncio.wait_for(asyncio.gather(
                *(client.get("/api/v1/system-status") for _ in range(40)),
                client.get("/api/healthz"), client.get("/api/v1/capabilities"),
                client.get("/api/v1/jobs/00000000-0000-0000-0000-000000000000"),
            ), timeout=2)
            assert all(response.status_code == 200 for response in responses[:-1])
            assert responses[-1].status_code == 404
            assert len(calls) == 1

    try:
        asyncio.run(exercise())
    finally:
        release.set()
        checker.stop()
