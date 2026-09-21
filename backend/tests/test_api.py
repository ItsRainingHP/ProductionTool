# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""End-to-end API tests for job creation, validation, and finalization."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app, store

CORPUS = Path(__file__).resolve().parents[2] / "examples"


@pytest.fixture(autouse=True)
def clean_job_store():
    store.stop()
    with store._lock, store._connect() as connection:
        for row in connection.execute("SELECT job_id FROM jobs").fetchall():
            store._delete_locked(row["job_id"], connection)
    store._creations.clear()
    yield
    store.stop()


def _wait_job(client: TestClient, job_id: str, statuses: set[str], timeout: float = 10) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/jobs/{job_id}")
        if response.status_code == 200 and response.json()["status"] in statuses:
            return response.json()
        time.sleep(0.02)
    raise AssertionError(f"Job {job_id} did not reach {statuses}")


def test_rfp_job_lifecycle() -> None:
    with TestClient(app) as client:
        created = client.post("/api/v1/jobs").json()
        source = CORPUS / "reference-sanitized/logikcull/pleading/valid/lc_reference_pleading_001.csv"
        with source.open("rb") as handle:
            uploaded = client.put(
                f"/api/v1/jobs/{created['job_id']}/source",
                files={"file": (source.name, handle, "text/csv")},
            )
        assert uploaded.status_code == 202
        analyzed = _wait_job(client, created["job_id"], {"needs_configuration", "failed"})
        assert analyzed["analysis"]["platform"] == "logikcull"
        assert analyzed["analysis"]["platform_confidence"] >= 80
        assert analyzed["workflow"] is None
        assert analyzed["pleading_settings"] is None
        selected = client.put(f"/api/v1/jobs/{created['job_id']}/workflow", json={"workflow": "rfp_ranges"})
        assert selected.status_code == 200
        configured = client.put(
            f"/api/v1/jobs/{created['job_id']}/pleading-settings",
            json={"delimiter": "semicolon", "include_and": False},
        )
        assert configured.status_code == 200
        assert configured.json()["pleading_settings"] == {"delimiter": "semicolon", "include_and": False}
        assert client.get(f"/api/v1/jobs/{created['job_id']}").json()["pleading_settings"] == {
            "delimiter": "semicolon",
            "include_and": False,
        }
        assert client.post(f"/api/v1/jobs/{created['job_id']}/review", json={}).status_code == 202
        reviewed = _wait_job(client, created["job_id"], {"ready_for_review", "failed"})
        assert reviewed["status"] == "ready_for_review"
        preview = client.get(f"/api/v1/jobs/{created['job_id']}/preview").json()
        assert preview["headers"] == ["RFP", "Bates Range"]
        assert preview["text"].startswith("RFP 01\r\n")
        assert "; " in preview["text"]
        assert "and " not in preview["text"]
        finalized = client.post(
            f"/api/v1/jobs/{created['job_id']}/finalize",
            json={
                "output_filename": "sample_ranges",
                "acknowledged_issue_codes": [],
                "review_token": preview["review_token"],
            },
        )
        assert finalized.status_code == 202
        completed = _wait_job(client, created["job_id"], {"complete", "failed"})
        assert completed["output_filename"] == "sample_ranges.txt"
        download = client.get(f"/api/v1/jobs/{created['job_id']}/download")
        assert download.status_code == 200
        assert download.headers["content-type"].startswith("text/plain")
        assert download.content.startswith(b"RFP 01\r\n")
        assert b"SYNREFLCPLD001-0000001; SYNREFLCPLD001-0000005-0006" in download.content
        assert b"RFP,Begin Bates,End Bates" not in download.content
        assert not download.content.startswith(b"\xef\xbb\xbf")
        json_receipt = client.get(f"/api/v1/jobs/{created['job_id']}/receipt.json")
        assert json_receipt.status_code == 200
        assert json_receipt.json()["output_sha256"]
        assert json_receipt.json()["input_sha256"]
        assert json_receipt.json()["pleading_settings"] == {"delimiter": "semicolon", "include_and": False}
        text_receipt = client.get(f"/api/v1/jobs/{created['job_id']}/receipt.txt")
        assert text_receipt.status_code == 200
        assert b"Production Tool Processing Receipt" in text_receipt.content
        assert json_receipt.json()["schema_version"] == 2
        assert client.get(f"/api/v1/jobs/{created['job_id']}/evidence.zip").status_code == 200
        assert download.headers["cache-control"] == "no-store"
        assert download.headers["x-content-type-options"] == "nosniff"
        assert download.headers["x-frame-options"] == "DENY"
        assert client.delete(f"/api/v1/jobs/{created['job_id']}").status_code == 204


def test_capabilities_are_the_runtime_source_of_limits() -> None:
    with TestClient(app) as client:
        response = client.get("/api/v1/capabilities")
        assert response.status_code == 200
        assert response.json() == {
            "max_upload_bytes": store.max_bytes,
            "job_ttl_seconds": store.ttl_seconds,
            "max_active_jobs": store.max_active_jobs,
            "max_total_job_bytes": store.max_total_bytes,
            "max_mapping_columns": 100,
            "max_source_fields_per_column": 100,
            "supported_content_types": sorted(store.capabilities().supported_content_types),
            "features": [
                "durable_jobs",
                "mapping_templates",
                "processing_receipts",
                "exact_review_artifacts",
                "evidence_packages",
            ],
        }


def _create_and_upload(client: TestClient, filename: str, content: bytes, content_type: str = "text/csv"):
    created = client.post("/api/v1/jobs").json()
    response = client.put(
        f"/api/v1/jobs/{created['job_id']}/source",
        files={"file": (filename, content, content_type)},
    )
    if response.status_code == 202:
        payload = _wait_job(client, created["job_id"], {"needs_configuration", "failed"})
        response._content = json_bytes(payload)
    return created["job_id"], response


def json_bytes(value: dict) -> bytes:
    import json

    return json.dumps(value).encode("utf-8")


def test_pleading_settings_validate_workflow_and_delimiter() -> None:
    pleading = b"Bates/Control #,End Bates/Control #,RFP\nTEST_0001,TEST_0002,RFP 01\n"
    privilege = b"Bates/Control #,End Bates/Control #,Description\nTEST_0001,TEST_0002,Legal advice\n"
    with TestClient(app) as client:
        pleading_id, pleading_upload = _create_and_upload(client, "pleading.csv", pleading)
        assert pleading_upload.status_code == 202
        invalid = client.put(
            f"/api/v1/jobs/{pleading_id}/pleading-settings",
            json={"delimiter": "tab", "include_and": True},
        )
        assert invalid.status_code == 422

        privilege_id, privilege_upload = _create_and_upload(client, "privilege.csv", privilege)
        assert privilege_upload.status_code == 202
        rejected = client.put(
            f"/api/v1/jobs/{privilege_id}/pleading-settings",
            json={"delimiter": "comma", "include_and": True},
        )
        assert rejected.status_code == 409


def test_upload_accepts_uppercase_csv_and_rejects_wrong_extension_and_mime() -> None:
    content = b"Bates/Control #,End Bates/Control #,RFP\nTEST_0001,TEST_0002,RFP 01\n"
    with TestClient(app) as client:
        _, accepted = _create_and_upload(client, "PRODUCTION.CSV", content)
        assert accepted.status_code == 202

        _, wrong_extension = _create_and_upload(client, "production.txt", content, "text/plain")
        assert wrong_extension.status_code == 415

        _, wrong_mime = _create_and_upload(client, "production.csv", content, "application/pdf")
        assert wrong_mime.status_code == 415


def test_binary_header_only_and_broken_quote_files_return_red_analysis() -> None:
    with TestClient(app) as client:
        for filename, content, expected_code in [
            ("empty.csv", b"", "empty_file"),
            ("invalid-utf8.csv", b"header\n\xff\xfe\n", "invalid_utf8"),
            ("binary.csv", b"Bates/Control #,End Bates/Control #\nA\x00B,C\n", "embedded_nul"),
            ("header.csv", b"Bates/Control #,End Bates/Control #,RFP\n", "no_data_rows"),
            ("broken.csv", b'Bates/Control #,End Bates/Control #,RFP\n"TEST_0001,TEST_0002,RFP 01\n', "broken_quote"),
        ]:
            _, response = _create_and_upload(client, filename, content)
            assert response.status_code == 202
            payload = response.json()
            assert payload["status"] == "failed"
            issue = next(item for item in payload["analysis"]["issues"] if item["code"] == expected_code)
            assert issue["severity"] in {"error", "fatal"}
            assert issue["overrideable"] is False


def test_red_job_cannot_enter_review_or_preview() -> None:
    with TestClient(app) as client:
        job_id, response = _create_and_upload(client, "empty.csv", b"")
        assert response.json()["status"] == "failed"
        assert client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": "rfp_ranges"}).status_code == 409
        assert client.post(f"/api/v1/jobs/{job_id}/review").status_code == 409
        assert client.get(f"/api/v1/jobs/{job_id}/preview").status_code == 409


def test_warnings_require_exact_acknowledgments() -> None:
    source = CORPUS / "generated/logikcull/pleading/invalid/lc_pleading_021_blank_bates_values.csv"
    with TestClient(app) as client, source.open("rb") as handle:
        created = client.post("/api/v1/jobs").json()
        uploaded = client.put(
            f"/api/v1/jobs/{created['job_id']}/source",
            files={"file": (source.name, handle, "text/csv")},
        )
        assert uploaded.status_code == 202
        payload = _wait_job(client, created["job_id"], {"needs_configuration", "failed"})
        assert payload["status"] == "needs_configuration"
        warning_codes = {item["code"] for item in payload["analysis"]["issues"]}
        assert warning_codes == {"blank_begin_bates", "blank_end_bates"}
        assert all(item["severity"] == "warning" and item["overrideable"] for item in payload["analysis"]["issues"])

        job_id = created["job_id"]
        assert client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": "rfp_ranges"}).status_code == 200
        missing = client.post(f"/api/v1/jobs/{job_id}/review", json={"acknowledged_issue_codes": []})
        assert missing.status_code == 409
        unknown = client.post(
            f"/api/v1/jobs/{job_id}/review",
            json={"acknowledged_issue_codes": ["made_up"]},
        )
        assert unknown.status_code == 422
        accepted = client.post(
            f"/api/v1/jobs/{job_id}/review",
            json={"acknowledged_issue_codes": sorted(warning_codes)},
        )
        assert accepted.status_code == 202
        reviewed = _wait_job(client, job_id, {"ready_for_review", "failed"})
        assert reviewed["status"] == "ready_for_review"
        complete = client.post(
            f"/api/v1/jobs/{job_id}/finalize",
            json={
                "output_filename": "warning",
                "acknowledged_issue_codes": sorted(warning_codes),
                "review_token": reviewed["review_token"],
            },
        )
        assert complete.status_code == 202
        assert _wait_job(client, job_id, {"complete", "failed"})["status"] == "complete"


def test_personal_data_findings_do_not_block_normalized_privilege_finalization() -> None:
    source = CORPUS / "generated/logikcull/privilege/valid/lc_privilege_feature_personal_data_normalization.csv"
    with TestClient(app) as client, source.open("rb") as handle:
        created = client.post("/api/v1/jobs").json()
        job_id = created["job_id"]
        uploaded = client.put(
            f"/api/v1/jobs/{job_id}/source",
            files={"file": (source.name, handle, "text/csv")},
        )
        assert uploaded.status_code == 202
        analyzed = _wait_job(client, job_id, {"needs_configuration", "failed"})
        findings = {item["category"]: item for item in analyzed["analysis"]["personal_data_findings"]}
        assert set(findings) == {"ssn", "date_of_birth", "personal_email", "single_word_name"}
        assert findings["personal_email"] == {
            "category": "personal_email",
            "count": 4,
            "columns": ["Author", "From", "To"],
        }
        assert analyzed["analysis"]["issues"] == []

        assert client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": "privilege_log"}).status_code == 200
        mapping = {
            "columns": [
                {
                    "id": "range",
                    "name": "Bates Range",
                    "source_fields": ["Bates/Control #", "End Bates/Control #"],
                    "transform": {"kind": "shorten_bates"},
                },
                {
                    "id": "author",
                    "name": "Author",
                    "source_fields": ["Author"],
                    "transform": {"kind": "none"},
                    "normalize": True,
                },
            ]
        }
        configured = client.put(f"/api/v1/jobs/{job_id}/mapping", json=mapping)
        assert configured.status_code == 200
        assert configured.json()["mapping"]["columns"][0]["normalize"] is False
        assert configured.json()["mapping"]["columns"][1]["normalize"] is True
        assert client.post(f"/api/v1/jobs/{job_id}/review", json={}).status_code == 202
        reviewed = _wait_job(client, job_id, {"ready_for_review", "failed"})
        assert reviewed["status"] == "ready_for_review"
        preview = client.get(f"/api/v1/jobs/{job_id}/preview?limit=5").json()
        assert preview["rows"][0][1] == "First Last synthetic.fixture.001@gmail.com"
        assert preview["rows"][1][1] == "O'Connor"
        assert preview["rows"][2][1] == "'=Dangerous"
        assert preview["formula_escapes"] == 1
        assert client.get(f"/api/v1/jobs/{job_id}/preview?limit=6").status_code == 422

        finalized = client.post(
            f"/api/v1/jobs/{job_id}/finalize",
            json={
                "output_filename": "personal_data_contacts",
                "acknowledged_issue_codes": [],
                "review_token": preview["review_token"],
            },
        )
        assert finalized.status_code == 202
        completed = _wait_job(client, job_id, {"complete", "failed"})
        assert completed["output_stats"]["formula_escapes"] == 1
        download = client.get(f"/api/v1/jobs/{job_id}/download")
        assert download.status_code == 200
        assert download.content.startswith(b"\xef\xbb\xbf")
        text = download.content.decode("utf-8-sig")
        assert "First Last synthetic.fixture.001@gmail.com" in text
        assert "O'Connor" in text
        assert "'=Dangerous" in text


@pytest.mark.parametrize("delimiter", ["comma", "semicolon", "pipe", "newline"])
@pytest.mark.parametrize("include_and", [True, False])
def test_every_pleading_setting_finalizes_through_api(delimiter: str, include_and: bool) -> None:
    source = (
        b"Bates/Control #,End Bates/Control #,RFP\n"
        b"TEST_0001,TEST_0001,RFP 01\n"
        b"TEST_0003,TEST_0003,RFP 01\n"
        b"TEST_0005,TEST_0005,RFP 01\n"
    )
    separators = {"comma": ", ", "semicolon": "; ", "pipe": " | ", "newline": "\r\n"}
    ranges = ["TEST_0001", "TEST_0003", "TEST_0005"]
    separator = separators[delimiter]
    expected = separator.join(ranges)
    if include_and:
        expected = f"{separator.join(ranges[:-1])}{separator}and {ranges[-1]}"

    with TestClient(app) as client:
        job_id, uploaded = _create_and_upload(client, "settings.csv", source)
        assert uploaded.status_code == 202
        assert client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": "rfp_ranges"}).status_code == 200
        configured = client.put(
            f"/api/v1/jobs/{job_id}/pleading-settings",
            json={"delimiter": delimiter, "include_and": include_and},
        )
        assert configured.status_code == 200
        assert client.post(f"/api/v1/jobs/{job_id}/review", json={}).status_code == 202
        reviewed = _wait_job(client, job_id, {"ready_for_review", "failed"})
        assert reviewed["status"] == "ready_for_review"
        finalized = client.post(
            f"/api/v1/jobs/{job_id}/finalize",
            json={
                "output_filename": f"settings_{delimiter}_{include_and}",
                "acknowledged_issue_codes": [],
                "review_token": reviewed["review_token"],
            },
        )
        assert finalized.status_code == 202
        assert _wait_job(client, job_id, {"complete", "failed"})["status"] == "complete"
        text = client.get(f"/api/v1/jobs/{job_id}/download").content.decode("utf-8")
        assert text == f"RFP 01\r\n{expected}\r\n"


def test_oversized_upload_leaves_no_partial_source() -> None:
    original_limit = store.max_bytes
    try:
        store.max_bytes = 8
        with TestClient(app) as client:
            job_id, response = _create_and_upload(client, "large.csv", b"header\nmore-than-eight-bytes")
            assert response.status_code == 413
            assert not (store.root / job_id / "source.csv").exists()
    finally:
        store.max_bytes = original_limit


def test_incompatible_rfp_workflow_and_stale_review_token_are_rejected() -> None:
    privilege = b"Author,Description\nSynthetic Person,Legal advice\n"
    with TestClient(app) as client:
        incompatible_id, uploaded = _create_and_upload(client, "privilege.csv", privilege)
        assert uploaded.status_code == 202
        assert (
            client.put(f"/api/v1/jobs/{incompatible_id}/workflow", json={"workflow": "rfp_ranges"}).status_code == 409
        )

        source = b"Bates/Control #,End Bates/Control #,RFP\nTEST_0001,TEST_0002,RFP 01\n"
        job_id, uploaded = _create_and_upload(client, "ranges.csv", source)
        assert uploaded.status_code == 202
        assert client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": "rfp_ranges"}).status_code == 200
        assert client.post(f"/api/v1/jobs/{job_id}/review", json={}).status_code == 202
        reviewed = _wait_job(client, job_id, {"ready_for_review", "failed"})
        assert reviewed["status"] == "ready_for_review"
        stale = client.post(
            f"/api/v1/jobs/{job_id}/finalize",
            json={"output_filename": "ranges", "acknowledged_issue_codes": [], "review_token": "0" * 64},
        )
        assert stale.status_code == 409

        changed = client.put(
            f"/api/v1/jobs/{job_id}/pleading-settings",
            json={"delimiter": "semicolon", "include_and": True},
        )
        assert changed.status_code == 200
        assert changed.json()["review_token"] is None
        old_review = client.post(
            f"/api/v1/jobs/{job_id}/finalize",
            json={
                "output_filename": "ranges",
                "acknowledged_issue_codes": [],
                "review_token": reviewed["review_token"],
            },
        )
        assert old_review.status_code == 409
