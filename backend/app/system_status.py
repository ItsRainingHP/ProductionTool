# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Cached, metadata-only checks for a newer published Production Tool image."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import Any
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .models import SystemStatus
from .release import APP_VERSION

REGISTRY = "https://registry-1.docker.io/v2/itsraininghp/production-tool"
TOKEN_URL = "https://auth.docker.io/token?service=registry.docker.io&scope=repository:itsraininghp/production-tool:pull"
MANIFEST_TYPES = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))
CHECK_INTERVAL = 3600
RETRY_INTERVAL = 300
REQUEST_TIMEOUT = 5
MAX_METADATA_BYTES = 1024 * 1024
logger = logging.getLogger(__name__)


class MetadataRedirectHandler(HTTPRedirectHandler):
    """Allow HTTPS CDN redirects without forwarding the registry bearer token."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != "https":
            raise ValueError("Image metadata redirects must use HTTPS")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and urlsplit(req.full_url).netloc != urlsplit(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


def _read_json(url: str, token: str | None = None) -> dict[str, Any]:
    headers = {"Accept": MANIFEST_TYPES, "User-Agent": "ProductionTool-update-check"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers)
    with build_opener(MetadataRedirectHandler()).open(request, timeout=REQUEST_TIMEOUT) as response:
        content = response.read(MAX_METADATA_BYTES + 1)
    if len(content) > MAX_METADATA_BYTES:
        raise ValueError("Image metadata exceeded its size limit")
    value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError("Image metadata must be a JSON object")
    return value


def _stable_version(value: str) -> tuple[int, ...] | None:
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", value):
        return None
    return tuple(int(part) for part in value.split("."))


def _digest(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError("Invalid image metadata digest")
    return value


def published_version() -> str:
    credentials = _read_json(TOKEN_URL)
    token = credentials.get("token") or credentials.get("access_token")
    if not isinstance(token, str) or not token:
        raise ValueError("The registry did not return a token")
    manifest = _read_json(f"{REGISTRY}/manifests/latest", token)
    if "manifests" in manifest:
        candidates = manifest["manifests"]
        if not isinstance(candidates, list):
            raise ValueError("Invalid image index")
        platform = next((item for item in candidates if isinstance(item, dict)
                         and isinstance(item.get("platform"), dict)
                         and item["platform"].get("os") == "linux"
                         and item["platform"].get("architecture") == "amd64"), None)
        if platform is None:
            raise ValueError("The published image does not support Linux/amd64")
        manifest = _read_json(f"{REGISTRY}/manifests/{_digest(platform.get('digest'))}", token)
    config = manifest.get("config")
    if not isinstance(config, dict):
        raise ValueError("Missing image configuration")
    image = _read_json(f"{REGISTRY}/blobs/{_digest(config.get('digest'))}", token)
    settings = image.get("config")
    environment = settings.get("Env") if isinstance(settings, dict) else None
    if not isinstance(environment, list):
        raise ValueError("Missing image environment")
    version = next((item.removeprefix("APP_VERSION=") for item in environment
                    if isinstance(item, str) and item.startswith("APP_VERSION=")), "")
    if _stable_version(version) is None:
        raise ValueError("Missing stable application version in the published image")
    return version


class SystemStatusChecker:
    """Share one check across browser clients and preserve the last good result."""

    def __init__(self, current_version: str = APP_VERSION) -> None:
        self.current_version = current_version
        self._latest_version: str | None = None
        self._next_check = 0.0
        self._lock = threading.Lock()
        self._enabled = True
        self._generation = 0
        self._worker: threading.Thread | None = None

    def start(self) -> None:
        with self._lock:
            self._enabled = True

    def stop(self) -> None:
        with self._lock:
            self._enabled = False
            self._generation += 1
            worker = self._worker
        if worker is not None:
            worker.join(timeout=2)

    def _refresh(self, generation: int) -> None:
        latest = None
        interval = RETRY_INTERVAL
        try:
            latest = published_version()
            interval = CHECK_INTERVAL
        except Exception as error:
            logger.warning("Update check unavailable (%s); retaining previous status", type(error).__name__)
        finally:
            with self._lock:
                if self._enabled and generation == self._generation:
                    if latest is not None:
                        self._latest_version = latest
                    self._next_check = time.monotonic() + interval
                self._worker = None

    def get(self) -> SystemStatus:
        with self._lock:
            if self._enabled and self._worker is None and time.monotonic() >= self._next_check:
                self._worker = threading.Thread(target=self._refresh, args=(self._generation,), daemon=True)
                self._worker.start()
            current = _stable_version(self.current_version)
            latest = _stable_version(self._latest_version) if self._latest_version is not None else None
            return SystemStatus(
                current_version=self.current_version,
                latest_version=self._latest_version,
                update_available=current is not None and latest is not None and latest > current,
            )
