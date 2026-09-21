# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Immutable release identity injected by the production image build."""

from __future__ import annotations

import os

APP_VERSION = os.getenv("APP_VERSION", "1.2.0")
BUILD_ID = os.getenv("BUILD_ID", "development")
SOURCE_REVISION = os.getenv("SOURCE_REVISION", "unversioned")
IMAGE_DIGEST = os.getenv("IMAGE_DIGEST", "unavailable")
