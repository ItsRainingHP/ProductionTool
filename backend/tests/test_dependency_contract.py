# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT
"""Prevent production dependency drift and the vulnerable SQLite runtime from returning."""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load_validator(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "deploy" / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("filename,pattern,new,message", [
    ("backend/requirements.txt", r"fastapi==[^\s;\\]+", "fastapi==0.1", "differs from lockfile"),
    ("backend/requirements.lock", r"fastapi==[^\s;\\]+", "fastapi==0.1", "differs from lockfile"),
    ("backend/requirements-dev.lock", r"uvicorn==[^\s;\\]+", "uvicorn==0.1", "locks differ for uvicorn"),
    ("Dockerfile", r"sqlite-libs=[^\s]+", "sqlite-libs=3.40.1-r0", "does not pin sqlite-libs"),
])
def test_release_gate_rejects_dependency_drift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, filename: str, pattern: str, new: str, message: str,
) -> None:
    paths = [
        "VERSION", "Dockerfile", "frontend/package.json", "frontend/package-lock.json",
        "deploy/release-metadata.json", "backend/app/jobs.py", "backend/app/main.py",
        "backend/app/release.py", "backend/app/models.py", "backend/requirements.txt",
        "backend/requirements-dev.txt", "backend/requirements.lock", "backend/requirements-dev.lock",
    ]
    for relative in paths:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    target = tmp_path / filename
    content = target.read_text(encoding="utf-8")
    changed, count = re.subn(pattern, new, content, count=1)
    assert count == 1
    target.write_text(changed, encoding="utf-8")
    validator = load_validator("verify_release_metadata")
    monkeypatch.setattr(validator, "ROOT", tmp_path)
    with pytest.raises(SystemExit, match=message):
        validator.main()


def test_runtime_gate_rejects_bookworm_sqlite(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    metadata = json.loads((ROOT / "deploy/release-metadata.json").read_text(encoding="utf-8"))
    metadata["runtime_versions"]["python"] = f"{sys.version_info.major}.{sys.version_info.minor}"
    (tmp_path / "release-metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    validator = load_validator("verify_runtime")
    monkeypatch.setattr(validator, "ROOT", tmp_path)
    node_version = metadata["runtime_versions"]["node"]
    monkeypatch.setattr(validator.subprocess, "check_output", lambda *_args, **_kwargs: f"v{node_version}\n")
    monkeypatch.setattr(validator.sqlite3, "sqlite_version_info", (3, 40, 1))
    monkeypatch.setattr(validator.sqlite3, "sqlite_version", "3.40.1")
    with pytest.raises(SystemExit, match="SQLite 3.40.1 <"):
        validator.main()
