# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT
"""Verify that release identifiers and pinned container bases agree."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require_match(pattern: str, text: str, description: str) -> str:
    match = re.search(pattern, text, flags=re.MULTILINE)
    if not match:
        raise SystemExit(f"Release metadata check failed: {description} was not found")
    return match.group(1)


def main() -> None:
    metadata = json.loads((ROOT / "deploy" / "release-metadata.json").read_text(encoding="utf-8"))
    canonical = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    package_lock = json.loads((ROOT / "frontend" / "package-lock.json").read_text(encoding="utf-8"))
    jobs_source = (ROOT / "backend" / "app" / "jobs.py").read_text(encoding="utf-8")
    main_source = (ROOT / "backend" / "app" / "main.py").read_text(encoding="utf-8")
    release_source = (ROOT / "backend" / "app" / "release.py").read_text(encoding="utf-8")
    models_source = (ROOT / "backend" / "app" / "models.py").read_text(encoding="utf-8")
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

    values = {
        "VERSION": canonical,
        "release metadata": metadata["application_version"],
        "frontend package": package["version"],
        "frontend lock root": package_lock["version"],
        "frontend lock package": package_lock["packages"][""]["version"],
        "application default": require_match(
            r'APP_VERSION = os\.getenv\("APP_VERSION", "([^"]+)"\)', release_source, "release APP_VERSION"
        ),
    }
    mismatches = {name: value for name, value in values.items() if value != canonical}
    if mismatches:
        detail = ", ".join(f"{name}={value}" for name, value in mismatches.items())
        raise SystemExit(f"Release metadata check failed: expected {canonical}; {detail}")

    if 'FastAPI(title="Production Tool API", version=APP_VERSION' not in main_source:
        api_contract = require_match(
            r'FastAPI\(title="Production Tool API", version="([^"]+)"', main_source, "API contract version"
        )
        if api_contract != metadata["api_contract_version"]:
            raise SystemExit(
                "Release metadata check failed: API contract version "
                f"{api_contract} != {metadata['api_contract_version']}"
            )

    if "from .release import APP_VERSION" not in jobs_source:
        receipt_version = require_match(r'^APP_VERSION = "([^"]+)"$', jobs_source, "receipt APP_VERSION")
        if receipt_version != canonical:
            raise SystemExit(
                f"Release metadata check failed: processing receipt version {receipt_version} != {canonical}"
            )

    receipt_schema = int(
        require_match(r"class Receipt\(BaseModel\):\s+schema_version: int = (\d+)", models_source, "receipt schema")
    )
    if receipt_schema != metadata["receipt_schema_version"]:
        raise SystemExit(
            "Release metadata check failed: receipt schema version "
            f"{receipt_schema} != {metadata['receipt_schema_version']}"
        )

    for image in metadata["base_images"].values():
        reference = image["reference"]
        if f"FROM {reference}" not in dockerfile:
            raise SystemExit(f"Release metadata check failed: Dockerfile does not use pinned base {reference}")

    if metadata["license"] != "MIT" or metadata["data_handling_model"] != "transient-processing-external-archive":
        raise SystemExit("Release metadata check failed: license or data-handling model changed without review")

    print(f"Release metadata is consistent for Production Tool {canonical}.")


if __name__ == "__main__":
    main()
