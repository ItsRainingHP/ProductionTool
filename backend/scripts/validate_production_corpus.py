# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Exercise every manifest fixture through the production job API and report results."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
CORPUS = ROOT / "examples"
MANIFEST_PATH = CORPUS / "manifest.json"
sys.path.insert(0, str(BACKEND))


def default_mapping(analysis: dict[str, Any]) -> dict[str, Any]:
    """Mirror the browser wizard's deterministic default privilege mapping."""
    columns: list[dict[str, Any]] = []
    assigned: set[str] = set()
    begin = analysis.get("begin_bates_header")
    end = analysis.get("end_bates_header")
    if begin and end:
        columns.append(
            {
                "id": "bates-range",
                "name": "Bates Range",
                "source_fields": [begin, end],
                "transform": {"kind": "shorten_bates", "delimiter": None},
                "normalize": False,
            }
        )
        assigned.update((begin, end))
    for index, header in enumerate(item for item in analysis["headers"] if item not in assigned):
        if index == 5:
            break
        columns.append(
            {
                "id": f"source-{index}",
                "name": header,
                "source_fields": [header],
                "transform": {"kind": "none", "delimiter": None},
                "normalize": False,
            }
        )
    return {"columns": columns}


def expected_fields(result: dict[str, Any]) -> dict[str, Any]:
    fields = {
        "outcome": result["outcome"],
        "outputRows": result["outputRows"],
        "outputCells": result["outputCells"],
        "outputSizeBytes": result["outputSizeBytes"],
        "skippedRows": result["skippedRows"],
        "formulaEscapes": result["formulaEscapes"],
        "outputSha256": result["outputSha256"],
    }
    return fields


def wait_for_job(client: TestClient, job_id: str, statuses: set[str], timeout: float = 30) -> dict[str, Any]:
    """Wait for a durable background operation to reach a terminal/configurable state."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/jobs/{job_id}")
        response.raise_for_status()
        payload = response.json()
        if payload["status"] in statuses:
            return payload
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not reach one of {sorted(statuses)}")


def exercise_fixture(client: TestClient, fixture: dict[str, Any]) -> dict[str, Any]:
    source = CORPUS / fixture["path"]
    started = time.perf_counter()
    created = client.post("/api/v1/jobs")
    created.raise_for_status()
    job_id = created.json()["job_id"]
    try:
        with source.open("rb") as handle:
            uploaded = client.put(
                f"/api/v1/jobs/{job_id}/source",
                files={"file": (source.name, handle, "text/csv")},
            )
        uploaded.raise_for_status()
        job = wait_for_job(client, job_id, {"needs_configuration", "failed"})
        analysis = job["analysis"]
        issue_codes = sorted(issue["code"] for issue in analysis["issues"])
        missing_codes = sorted(set(fixture["expectedErrors"]) - set(issue_codes))
        if missing_codes:
            raise AssertionError(f"missing expected issues: {', '.join(missing_codes)}")

        base = {
            "id": fixture["id"],
            "platform": analysis["platform"],
            "workflow": "rfp_ranges" if fixture["dataType"] == "pleading" else "privilege_log",
            "inputRows": fixture["rowCount"],
            "issues": issue_codes,
            "outputRows": None,
            "outputCells": None,
            "outputSizeBytes": None,
            "skippedRows": None,
            "formulaEscapes": None,
            "outputSha256": None,
        }
        if job["status"] == "failed":
            if client.post(f"/api/v1/jobs/{job_id}/review").status_code != 409:
                raise AssertionError("blocked fixture unexpectedly entered review")
            if client.get(f"/api/v1/jobs/{job_id}/preview").status_code != 409:
                raise AssertionError("blocked fixture unexpectedly produced a preview")
            finalize = client.post(
                f"/api/v1/jobs/{job_id}/finalize",
                json={"output_filename": fixture["id"], "acknowledged_issue_codes": [], "review_token": "0" * 64},
            )
            if finalize.status_code != 409:
                raise AssertionError("blocked fixture unexpectedly finalized")
            return {
                **base,
                "outcome": "blocked",
                "processingMs": round((time.perf_counter() - started) * 1000),
            }

        workflow = base["workflow"]
        configured = client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": workflow})
        configured.raise_for_status()
        if workflow == "privilege_log":
            mapping = default_mapping(analysis)
            mapped = client.put(f"/api/v1/jobs/{job_id}/mapping", json=mapping)
            mapped.raise_for_status()
        else:
            settings = client.put(
                f"/api/v1/jobs/{job_id}/pleading-settings",
                json={"delimiter": "comma", "include_and": True},
            )
            settings.raise_for_status()
        warning_codes = sorted(issue["code"] for issue in analysis["issues"] if issue["overrideable"])
        reviewed = client.post(
            f"/api/v1/jobs/{job_id}/review",
            json={"acknowledged_issue_codes": warning_codes},
        )
        reviewed.raise_for_status()
        reviewed_job = wait_for_job(client, job_id, {"ready_for_review", "failed"})
        if reviewed_job["status"] != "ready_for_review":
            raise AssertionError(f"review preparation failed: {reviewed_job.get('error_code')}")
        preview = client.get(f"/api/v1/jobs/{job_id}/preview?limit=5")
        preview.raise_for_status()
        finalized = client.post(
            f"/api/v1/jobs/{job_id}/finalize",
            json={
                "output_filename": fixture["id"].lower(),
                "acknowledged_issue_codes": warning_codes,
                "review_token": preview.json()["review_token"],
            },
        )
        finalized.raise_for_status()
        final_job = wait_for_job(client, job_id, {"complete", "failed"})
        if final_job["status"] != "complete":
            raise AssertionError(f"finalization failed: {final_job.get('error_code')}")
        download = client.get(f"/api/v1/jobs/{job_id}/download")
        download.raise_for_status()
        stats = final_job["output_stats"]
        if preview.json()["total_rows"] != stats["output_rows"]:
            raise AssertionError("preview and finalized output row counts differ")
        return {
            **base,
            "outcome": "complete_with_warnings" if warning_codes else "complete",
            "outputRows": stats["output_rows"],
            "outputCells": stats["output_cells"],
            "outputSizeBytes": stats["output_size_bytes"],
            "skippedRows": stats["skipped_rows"],
            "formulaEscapes": stats["formula_escapes"],
            "outputSha256": hashlib.sha256(download.content).hexdigest(),
            "processingMs": round((time.perf_counter() - started) * 1000),
        }
    finally:
        deleted = client.delete(f"/api/v1/jobs/{job_id}")
        if deleted.status_code not in {204, 404}:
            deleted.raise_for_status()


def aggregate(results: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "fixtures": len(results),
        "inputRows": sum(item["inputRows"] for item in results),
        "processable": sum(item["outcome"] != "blocked" for item in results),
        "clean": sum(item["outcome"] == "complete" for item in results),
        "withWarnings": sum(item["outcome"] == "complete_with_warnings" for item in results),
        "blocked": sum(item["outcome"] == "blocked" for item in results),
        "pleadingOutputs": sum(item["workflow"] == "rfp_ranges" and item["outcome"] != "blocked" for item in results),
        "privilegeOutputs": sum(
            item["workflow"] == "privilege_log" and item["outcome"] != "blocked" for item in results
        ),
        "outputRows": sum(item["outputRows"] or 0 for item in results),
        "outputCells": sum(item["outputCells"] or 0 for item in results),
        "outputSizeBytes": sum(item["outputSizeBytes"] or 0 for item in results),
        "skippedRows": sum(item["skippedRows"] or 0 for item in results),
        "formulaEscapes": sum(item["formulaEscapes"] or 0 for item in results),
        "processingMs": sum(item["processingMs"] for item in results),
    }


def markdown_report(results: list[dict[str, Any]], totals: dict[str, int], mismatches: list[str]) -> str:
    lines = [
        "# CSV production validation",
        "",
        f"**Result:** {'PASS' if not mismatches else 'FAIL'}",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
    ]
    for label, key in (
        ("Fixtures examined", "fixtures"),
        ("Input rows declared", "inputRows"),
        ("Processable", "processable"),
        ("Clean completions", "clean"),
        ("Completions with warnings", "withWarnings"),
        ("Blocked", "blocked"),
        ("Pleading outputs", "pleadingOutputs"),
        ("Privilege outputs", "privilegeOutputs"),
        ("Output rows", "outputRows"),
        ("Output cells", "outputCells"),
        ("Output bytes", "outputSizeBytes"),
        ("Skipped rows", "skippedRows"),
        ("Formula escapes", "formulaEscapes"),
        ("Measured processing time (ms)", "processingMs"),
    ):
        lines.append(f"| {label} | {totals[key]:,} |")
    if mismatches:
        lines.extend(("", "## Mismatches", "", *(f"- {item}" for item in mismatches)))
    lines.extend(
        (
            "",
            "## Fixture results",
            "",
            "| Fixture | Platform | Workflow | Input rows | Issues | Result | Output rows | "
            "Cells | Bytes | Skipped | Escapes | SHA-256 |",
            "| --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
        )
    )
    for item in results:
        digest = item["outputSha256"] or "—"
        display = {
            **item,
            "issues": ", ".join(item["issues"]) or "—",
            "outputRows": f"{item['outputRows']:,}" if item["outputRows"] is not None else "—",
            "outputCells": f"{item['outputCells']:,}" if item["outputCells"] is not None else "—",
            "outputSizeBytes": f"{item['outputSizeBytes']:,}" if item["outputSizeBytes"] is not None else "—",
            "skippedRows": f"{item['skippedRows']:,}" if item["skippedRows"] is not None else "—",
            "formulaEscapes": f"{item['formulaEscapes']:,}" if item["formulaEscapes"] is not None else "—",
            "digest": digest,
        }
        lines.append(
            "| {id} | {platform} | {workflow} | {inputRows:,} | {issues} | {outcome} | {outputRows} | "
            "{outputCells} | {outputSizeBytes} | {skippedRows} | {formulaEscapes} | `{digest}` |".format(**display)
        )
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json-report", type=Path, required=True)
    parser.add_argument("--markdown-report", type=Path, required=True)
    parser.add_argument("--update-expectations", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    mismatches: list[str] = []
    with tempfile.TemporaryDirectory(prefix="production-tool-corpus-") as job_root:
        os.environ["JOB_DATA_DIR"] = job_root
        os.environ["MAX_JOB_CREATIONS_PER_MINUTE"] = str(len(manifest["fixtures"]) + 10)
        from app.main import app

        with TestClient(app) as client:
            results = [exercise_fixture(client, fixture) for fixture in manifest["fixtures"]]
    totals = aggregate(results)

    if args.update_expectations:
        result_by_id = {item["id"]: item for item in results}
        for fixture in manifest["fixtures"]:
            fixture["expectedWizard"] = expected_fields(result_by_id[fixture["id"]])
        manifest["wizardAggregateExpectations"] = {key: value for key, value in totals.items() if key != "processingMs"}
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    else:
        for fixture, result in zip(manifest["fixtures"], results, strict=True):
            expected = fixture.get("expectedWizard")
            actual = expected_fields(result)
            if expected != actual:
                mismatches.append(f"{fixture['id']}: expected {expected!r}, got {actual!r}")
        expected_totals = manifest.get("wizardAggregateExpectations")
        actual_totals = {key: value for key, value in totals.items() if key != "processingMs"}
        if expected_totals != actual_totals:
            mismatches.append(f"aggregate totals: expected {expected_totals!r}, got {actual_totals!r}")

    report = {
        "schemaVersion": 1,
        "passed": not mismatches,
        "totals": totals,
        "mismatches": mismatches,
        "fixtures": results,
    }
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    args.markdown_report.write_text(markdown_report(results, totals, mismatches), encoding="utf-8")
    print(f"Validated {totals['fixtures']} fixtures: {totals['processable']} processable, {totals['blocked']} blocked")
    print(f"Reports: {args.markdown_report} and {args.json_report}")
    if mismatches:
        for mismatch in mismatches:
            print(f"ERROR: {mismatch}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
