# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Production image identity must be injected at startup."""

from __future__ import annotations

import importlib

import pytest

from app import release


def test_production_requires_valid_image_digest(monkeypatch: pytest.MonkeyPatch) -> None:
    try:
        with monkeypatch.context() as configured:
            configured.setenv("REQUIRE_IMAGE_DIGEST", "1")
            configured.setenv("IMAGE_DIGEST", "sha256:<placeholder>")
            with pytest.raises(RuntimeError, match="verified image digest"):
                importlib.reload(release)
            configured.setenv("IMAGE_DIGEST", "sha256:" + "a" * 64)
            assert importlib.reload(release).IMAGE_DIGEST == "sha256:" + "a" * 64
    finally:
        importlib.reload(release)
