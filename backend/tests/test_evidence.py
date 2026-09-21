# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

import hashlib
import json
import zipfile
from pathlib import Path

from app.evidence import build_evidence_package


def test_evidence_package_manifest_verifies_every_archived_file(tmp_path: Path) -> None:
    output = tmp_path / "output.csv"
    output.write_bytes(b"Header\r\nValue\r\n")
    (tmp_path / "receipt.json").write_text("{}\n", encoding="utf-8")
    (tmp_path / "receipt.txt").write_text("Receipt\r\n", encoding="utf-8")

    package = build_evidence_package(tmp_path, output, "matter.csv")

    with zipfile.ZipFile(package) as archive:
        assert set(archive.namelist()) == {"matter.csv", "receipt.json", "receipt.txt", "evidence-manifest.json"}
        manifest = json.loads(archive.read("evidence-manifest.json"))
        for entry in manifest["files"]:
            assert hashlib.sha256(archive.read(entry["name"])).hexdigest() == entry["sha256"]
            assert len(archive.read(entry["name"])) == entry["size_bytes"]
