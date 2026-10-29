# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT
"""Verify the installed production interpreters, SQLite, and locked Python packages."""

from __future__ import annotations

import importlib.metadata
import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> None:
    metadata = json.loads((ROOT / "release-metadata.json").read_text(encoding="utf-8"))
    expected = metadata["runtime_versions"]
    python_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    if python_version != expected["python"]:
        raise SystemExit(f"Runtime check failed: Python {python_version} != {expected['python']}")
    node_version = subprocess.check_output(["node", "--version"], text=True).strip().removeprefix("v")
    if node_version != expected["node"]:
        raise SystemExit(f"Runtime check failed: Node {node_version} != {expected['node']}")
    minimum_sqlite = tuple(int(part) for part in expected["sqlite_minimum"].split("."))
    if sqlite3.sqlite_version_info < minimum_sqlite:
        raise SystemExit(
            f"Runtime check failed: SQLite {sqlite3.sqlite_version} < {expected['sqlite_minimum']}"
        )
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute("CREATE TABLE runtime_check (value INTEGER NOT NULL)")
        connection.execute("INSERT INTO runtime_check VALUES (1)")
        if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise SystemExit("Runtime check failed: SQLite integrity check")
    finally:
        connection.close()
    expected_user = metadata["runtime_user"]
    if (os.getuid(), os.getgid()) != (expected_user["uid"], expected_user["gid"]):
        raise SystemExit("Runtime check failed: application UID/GID changed; retained job ownership must be preserved")
    installed = {}
    lockfile = ROOT / "backend" / "requirements.lock"
    for name, version in re.findall(
        r"^([\w.-]+)==([^\s;\\]+)", lockfile.read_text(encoding="utf-8"), flags=re.MULTILINE
    ):
        actual = importlib.metadata.version(name)
        if actual != version:
            raise SystemExit(f"Runtime check failed: {name} {actual} != locked {version}")
        installed[name] = actual
    if not installed:
        raise SystemExit("Runtime check failed: production dependency lockfile is empty")
    print(json.dumps({"python": python_version, "node": node_version, "sqlite": sqlite3.sqlite_version,
                      "uid": os.getuid(), "gid": os.getgid(),
                      "packages": installed}, sort_keys=True))


if __name__ == "__main__":
    main()
