# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Create the self-verifying evidence package archived outside the transient tool."""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def build_evidence_package(directory: Path, output: Path, output_filename: str) -> Path:
    inputs = [
        (output, output_filename),
        (directory / "receipt.json", "receipt.json"),
        (directory / "receipt.txt", "receipt.txt"),
    ]
    manifest = {
        "schema_version": 1,
        "purpose": "Transient Production Tool evidence package for archival in the approved matter repository.",
        "files": [
            {"name": archive_name, "size_bytes": path.stat().st_size, "sha256": _sha256(path)}
            for path, archive_name in inputs
        ],
    }
    manifest_path = directory / "evidence-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    package_path = directory / "evidence-package.zip"
    temporary = directory / "evidence-package.zip.partial"
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path, archive_name in inputs:
            archive.write(path, archive_name)
        archive.write(manifest_path, "evidence-manifest.json")
    temporary.replace(package_path)
    return package_path
