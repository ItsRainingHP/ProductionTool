# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Immutable release identity injected by the production image build."""

from __future__ import annotations

import os
import re

APP_VERSION = os.getenv("APP_VERSION", "2.0.4")
BUILD_ID = os.getenv("BUILD_ID", "development")
SOURCE_REVISION = os.getenv("SOURCE_REVISION", "unversioned")
IMAGE_DIGEST = os.getenv("IMAGE_DIGEST", "unavailable")
if os.getenv("REQUIRE_IMAGE_DIGEST") == "1" and not re.fullmatch(r"sha256:[0-9a-f]{64}", IMAGE_DIGEST):
    raise RuntimeError("A verified image digest is required for production processing")
