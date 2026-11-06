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
def clean_job_store(request):
    assert store.root.resolve() == request.config.production_test_root
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
                content=handle.read(),
                headers={"Content-Type": "text/csv", "X-File-Name": source.name},
            )
        assert uploaded.status_code == 202
        analyzed = _wait_job(client, created["job_id"], {"needs_configuration", "failed"})
        assert analyzed["analysis"]["platform"] == "unknown"
        assert analyzed["analysis"]["platform_confidence"] == 40
        assert analyzed["workflow"] is None
        assert analyzed["pleading_settings"] is None
        selected = client.put(f"/api/v1/jobs/{created['job_id']}/workflow", json={"workflow": "rfp_ranges"})
        assert selected.status_code == 200
        configured = client.put(
            f"/api/v1/jobs/{created['job_id']}/pleading-settings",
            json={"delimiter": "semicolon", "include_and": False},
        )
        assert configured.status_code == 200
        assert configured.json()["pleading_settings"] == {
            "delimiter": "semicolon", "include_and": False, "request_sources": None,
        }
        assert client.get(f"/api/v1/jobs/{created['job_id']}").json()["pleading_settings"] == {
            "delimiter": "semicolon",
            "include_and": False,
            "request_sources": None,
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
        assert b"SYNREFLCPLD001-0000001; SYNREFLCPLD001-0000005-6" in download.content
        assert b"RFP,Begin Bates,End Bates" not in download.content
        assert not download.content.startswith(b"\xef\xbb\xbf")
        json_receipt = client.get(f"/api/v1/jobs/{created['job_id']}/receipt.json")
        assert json_receipt.status_code == 200
        assert json_receipt.json()["output_sha256"]
        assert json_receipt.json()["input_sha256"]
        assert json_receipt.json()["pleading_settings"] == {
            "delimiter": "semicolon", "include_and": False, "request_sources": None,
        }
        text_receipt = client.get(f"/api/v1/jobs/{created['job_id']}/receipt.txt")
        assert text_receipt.status_code == 200
        assert b"Production Tool Processing Receipt" in text_receipt.content
        assert json_receipt.json()["schema_version"] == 3
        assert client.get(f"/api/v1/jobs/{created['job_id']}/evidence.zip").status_code == 200
        assert download.headers["cache-control"] == "no-store"
        assert download.headers["x-content-type-options"] == "nosniff"
        assert download.headers["x-frame-options"] == "DENY"
        assert client.delete(f"/api/v1/jobs/{created['job_id']}").status_code == 204


def test_custom_everlaw_request_sources_recover_and_finalize() -> None:
    source = (b'Bates/Control #,End Bates/Control #,Matter,Matter: Alpha,Privilege: Withheld\n'
              b'SYN_0001,SYN_0002,"Alpha; Beta",Alpha,null\n'
              b'SYN_0003,SYN_0004,null,null,Withheld\n')
    with TestClient(app) as client:
        job_id, uploaded = _create_and_upload(client, "custom-codes.csv", source)
        assert uploaded.status_code == 202
        endpoint = f"/api/v1/jobs/{job_id}"
        analysis = client.get(endpoint).json()["analysis"]
        assert analysis["request_count"] == 0
        assert not any(c["suggested"] for c in analysis["request_candidates"])
        assert client.put(endpoint + "/workflow", json={"workflow": "rfp_ranges"}).status_code == 200
        for columns in [[{"column": "Missing"}], [{"column": "Bates/Control #"}],
                        [{"column": "Matter"}, {"column": "Matter"}]]:
            assert client.put(endpoint + "/pleading-settings", json={"request_sources": columns}).status_code == 422
        settings = {"request_sources": [{"column": "Matter", "layout": "category"}]}
        assert client.put(endpoint + "/pleading-settings", json=settings).status_code == 200
        assert client.post(endpoint + "/review", json={}).status_code == 202
        problem = _wait_job(client, job_id, {"needs_configuration", "failed"})
        assert problem["status"] == "needs_configuration"
        assert problem["error_code"] == "request_source_configuration"
        assert problem["analysis"]["issues"][0]["code"] == "ambiguous_request_separator"
        assert client.get(endpoint + "/preview").status_code == 409
        switched = client.put(endpoint + "/workflow", json={"workflow": "privilege_log"}).json()
        assert switched["analysis"]["issues"] == []
        assert switched["error_code"] is None
        client.put(endpoint + "/workflow", json={"workflow": "rfp_ranges"}).raise_for_status()
        settings["request_sources"][0]["input_separator"] = "semicolon"
        settings["request_sources"].append({"column": "Matter: Alpha"})
        saved = client.put(endpoint + "/pleading-settings", json=settings).json()
        assert saved["analysis"]["issues"] == []
        assert client.get(endpoint).json()["pleading_settings"] == saved["pleading_settings"]
        assert client.post(endpoint + "/review", json={}).status_code == 202
        ready = _wait_job(client, job_id, {"ready_for_review", "needs_configuration", "failed"})
        assert ready["status"] == "ready_for_review", ready
        preview = client.get(endpoint + "/preview").json()
        assert preview["text"] == "Alpha\r\nSYN_0001-2\r\n\r\nBeta\r\nSYN_0001-2\r\n"
        assert client.post(endpoint + "/finalize", json={
            "output_filename": "custom", "review_token": preview["review_token"],
        }).status_code == 202
        assert _wait_job(client, job_id, {"complete", "failed"})["status"] == "complete"
        assert client.get(endpoint + "/download").content.decode() == preview["text"]
        receipt = client.get(endpoint + "/receipt.json").json()
        assert receipt["pleading_settings"] == saved["pleading_settings"]
        assert receipt["output_sha256"] == preview["artifact_sha256"]
        assert store.source_path(job_id).read_bytes() == source
        assert client.put(endpoint + "/pleading-settings", json={"request_sources": []}).status_code == 200
        assert client.get(endpoint + "/preview").status_code == 409
        assert client.post(endpoint + "/review", json={}).status_code == 409


def test_selected_request_warnings_require_acknowledgment_and_empty_sources_recover() -> None:
    source = (b"Begin Bates,End Bates,Custom: Notes,Empty\n"
              b"SYN_0001,SYN_0002,Notes,null\nSYN_0003,SYN_0004,Wrong value,null\n")
    with TestClient(app) as client:
        job_id, _ = _create_and_upload(client, "custom.csv", source)
        endpoint = f"/api/v1/jobs/{job_id}"
        client.put(endpoint + "/workflow", json={"workflow": "rfp_ranges"}).raise_for_status()
        settings = {"request_sources": [{"column": "Custom: Notes"}]}
        client.put(endpoint + "/pleading-settings", json=settings).raise_for_status()
        assert client.post(endpoint + "/review", json={}).status_code == 202
        problem = _wait_job(client, job_id, {"needs_configuration", "failed"})
        assert problem["status"] == "needs_configuration"
        assert problem["analysis"]["issues"][0]["code"] == "unexpected_request_value"
        assert client.post(endpoint + "/review", json={}).status_code == 409
        settings["delimiter"] = "semicolon"
        client.put(endpoint + "/pleading-settings", json=settings).raise_for_status()
        assert client.post(endpoint + "/review", json={
            "acknowledged_issue_codes": ["unexpected_request_value"],
        }).status_code == 202
        ready = _wait_job(client, job_id, {"ready_for_review", "needs_configuration", "failed"})
        assert ready["status"] == "ready_for_review"
        assert client.get(endpoint + "/preview").json()["text"] == "Notes\r\nSYN_0001-2\r\n"
        client.put(endpoint + "/pleading-settings", json={"request_sources": [{"column": "Empty"}]}).raise_for_status()
        assert client.post(endpoint + "/review", json={}).status_code == 202
        empty = _wait_job(client, job_id, {"needs_configuration", "failed"})
        assert empty["status"] == "needs_configuration"
        assert "no recoverable" in empty["error"]


def test_receipt_sums_request_warning_occurrences_across_columns() -> None:
    source = (b"Begin Bates,End Bates,Matter: Notes,Matter: Emails\n"
              b"SYN_0001,SYN_0002,Notes,Emails\nSYN_0003,SYN_0004,Wrong,Wrong\n")
    with TestClient(app) as client:
        job_id, _ = _create_and_upload(client, "synthetic.csv", source)
        endpoint = f"/api/v1/jobs/{job_id}"
        client.put(endpoint + "/workflow", json={"workflow": "rfp_ranges"}).raise_for_status()
        client.put(endpoint + "/pleading-settings", json={"request_sources": [
            {"column": "Matter: Notes"}, {"column": "Matter: Emails"},
        ]}).raise_for_status()
        client.post(endpoint + "/review", json={}).raise_for_status()
        problem = _wait_job(client, job_id, {"needs_configuration", "failed"})
        assert len(problem["analysis"]["issues"]) == 2
        acknowledged = ["unexpected_request_value"]
        client.post(endpoint + "/review", json={"acknowledged_issue_codes": acknowledged}).raise_for_status()
        ready = _wait_job(client, job_id, {"ready_for_review", "needs_configuration", "failed"})
        assert ready["status"] == "ready_for_review"
        client.post(endpoint + "/finalize", json={"output_filename": "synthetic",
            "review_token": ready["review_token"], "acknowledged_issue_codes": acknowledged}).raise_for_status()
        assert _wait_job(client, job_id, {"complete", "failed"})["status"] == "complete"
        assert client.get(endpoint + "/receipt.json").json()["issue_counts"] == {"unexpected_request_value": 2}


def test_capabilities_are_the_runtime_source_of_limits() -> None:
    with TestClient(app) as client:
        response = client.get("/api/v1/capabilities")
        assert response.status_code == 200
        assert response.headers["referrer-policy"] == "same-origin"
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
        content=content,
        headers={"Content-Type": content_type, "X-File-Name": filename},
    )
    if response.status_code == 202:
        payload = _wait_job(client, created["job_id"], {"needs_configuration", "failed"})
        response._content = json_bytes(payload)
    return created["job_id"], response


def json_bytes(value: dict) -> bytes:
    import json

    return json.dumps(value).encode("utf-8")


def test_column_true_replacement_toggle_invalidates_review_and_persists_in_receipts() -> None:
    source = (
        b"Bates/Control #,End Bates/Control #,Subject,Tag: Attorney Client\n"
        b"EXAMPLE_000001,EXAMPLE_000001,Re: True-up calculation for Q3,TRUE\n"
        b"EXAMPLE_000002,EXAMPLE_000002,Is this statement true?,true\n"
        b"EXAMPLE_000003,EXAMPLE_000003,True copy of signed agreement,  TrUe  \n"
    )
    mapping = {"columns": [
        {"id": "subject", "name": "Subject", "source_fields": ["Subject"]},
        {"id": "reason", "name": "Reason", "source_fields": ["Tag: Attorney Client"], "replace_true_with_header": True},
    ]}
    with TestClient(app) as client:
        job_id, uploaded = _create_and_upload(client, "markers.csv", source)
        assert uploaded.status_code == 202
        assert client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": "privilege_log"}).status_code == 200
        saved = client.put(f"/api/v1/jobs/{job_id}/mapping", json=mapping)
        assert saved.status_code == 200
        assert saved.json()["mapping"]["columns"][1]["replace_true_with_header"] is True
        assert client.post(f"/api/v1/jobs/{job_id}/review", json={}).status_code == 202
        reviewed = _wait_job(client, job_id, {"ready_for_review", "failed"})
        assert reviewed["status"] == "ready_for_review"
        assert client.get(f"/api/v1/jobs/{job_id}/preview").json()["rows"] == [
            ["Re: True-up calculation for Q3", "Attorney Client"],
            ["Is this statement true?", "Attorney Client"],
            ["True copy of signed agreement", "Attorney Client"],
        ]

        disabled = {"columns": [mapping["columns"][0], {**mapping["columns"][1], "replace_true_with_header": False}]}
        saved = client.put(f"/api/v1/jobs/{job_id}/mapping", json=disabled)
        assert saved.status_code == 200
        assert saved.json()["review_token"] is None
        assert saved.json()["configuration_revision"] > reviewed["configuration_revision"]
        assert saved.json()["staged_artifact_sha256"] is None
        assert client.get(f"/api/v1/jobs/{job_id}").json()["mapping"]["columns"][1]["replace_true_with_header"] is False
        assert client.get(f"/api/v1/jobs/{job_id}/preview").status_code == 409
        assert client.post(f"/api/v1/jobs/{job_id}/finalize", json={
            "output_filename": "stale", "review_token": reviewed["review_token"],
        }).status_code == 409
        assert client.post(f"/api/v1/jobs/{job_id}/review", json={}).status_code == 202
        reviewed = _wait_job(client, job_id, {"ready_for_review", "failed"})
        assert reviewed["status"] == "ready_for_review"
        assert client.get(f"/api/v1/jobs/{job_id}/preview").json()["rows"] == [
            ["Re: True-up calculation for Q3", "TRUE"],
            ["Is this statement true?", "true"],
            ["True copy of signed agreement", "  TrUe  "],
        ]
        assert client.post(f"/api/v1/jobs/{job_id}/finalize", json={
            "output_filename": "markers", "review_token": reviewed["review_token"],
        }).status_code == 202
        assert _wait_job(client, job_id, {"complete", "failed"})["status"] == "complete"
        assert client.get(f"/api/v1/jobs/{job_id}/download").content.decode("utf-8-sig") == (
            "Subject,Reason\r\n"
            "Re: True-up calculation for Q3,TRUE\r\n"
            "Is this statement true?,true\r\n"
            "True copy of signed agreement,  TrUe  \r\n"
        )
        receipt_mapping = client.get(f"/api/v1/jobs/{job_id}/receipt.json").json()["mapping"]
        assert receipt_mapping["columns"][1]["replace_true_with_header"] is False
        assert b'"replace_true_with_header":false' in client.get(f"/api/v1/jobs/{job_id}/receipt.txt").content
        assert store.source_path(job_id).read_bytes() == source


def test_mapping_blank_check_reports_output_gaps_without_saving_the_mapping() -> None:
    source = (
        b"Bates/Control #,End Bates/Control #,Author,Recipient\n"
        b"TEST0001,TEST0002,Alice,\n"
        b"TEST0003,TEST0004,,Bob\n"
        b"TEST0005,TEST0006,, \n"
    )
    with TestClient(app) as client:
        job_id, uploaded = _create_and_upload(client, "privilege-blanks.csv", source)
        assert uploaded.status_code == 202
        mapping = {"columns": [
            {"id": "author", "name": "Author", "source_fields": ["Author"]},
            {"id": "person", "name": "Person", "source_fields": ["Author", "Recipient"],
             "transform": {"kind": "fill"}},
        ]}
        assert client.post(f"/api/v1/jobs/{job_id}/mapping/blank-cells", json=mapping).status_code == 409
        before = client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": "privilege_log"}).json()
        response = client.post(f"/api/v1/jobs/{job_id}/mapping/blank-cells", json=mapping)
        assert response.status_code == 200
        assert response.json() == {"blank_cells": [2, 1], "output_rows": 3}
        after = client.get(f"/api/v1/jobs/{job_id}").json()
        assert after["mapping"] is None
        assert after["revision"] == before["revision"]
        mapping["columns"][0]["source_fields"] = ["Missing field"]
        assert client.post(f"/api/v1/jobs/{job_id}/mapping/blank-cells", json=mapping).status_code == 422


def test_mapping_blank_check_uses_logikcull_flag_headers() -> None:
    source = CORPUS / "generated/logikcull/privilege/valid/lc_privilege_feature_true_blank_flags.csv"
    mapping = {"columns": [
        {"id": "direct", "name": "Direct", "source_fields": ["Attorney Client"]},
        {"id": "joined", "name": "Joined", "source_fields": ["Attorney Client", "Work Product"],
         "transform": {"kind": "delimit", "delimiter": "; "}},
    ]}
    with TestClient(app) as client:
        job_id, uploaded = _create_and_upload(client, source.name, source.read_bytes())
        assert uploaded.status_code == 202
        assert uploaded.json()["analysis"]["true_blank_headers"] == ["Attorney Client", "Work Product"]
        assert client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": "privilege_log"}).status_code == 200
        response = client.post(f"/api/v1/jobs/{job_id}/mapping/blank-cells", json=mapping)
        assert response.status_code == 200
        assert response.json() == {"blank_cells": [1, 0], "output_rows": 3}


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
            ("invalid-utf8.csv", b"header\n\x81\n", "invalid_utf8"),
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
            content=handle.read(),
            headers={"Content-Type": "text/csv", "X-File-Name": source.name},
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


@pytest.mark.parametrize("workflow", ["rfp_ranges", "privilege_log"])
def test_bates_only_warning_requires_acknowledgment_and_preserves_workflow_output(workflow: str) -> None:
    source = (
        b"Begin Bates,End Bates,Tag: RFP 01,Redact,Withhold,Subject\r\n"
        b"ABC0001,ABC0002,TRUE,Redact,,Populated subject\r\n"
        b"ABC0003,ABC0004,,,,\r\n"
        b"ABC0005,ABC0006, ,\t, , \r\n"
    )
    with TestClient(app) as client:
        job_id, uploaded = _create_and_upload(client, "bates-only.csv", source)
        payload = uploaded.json()
        assert payload["status"] == "needs_configuration"
        assert [(item["code"], item["count"], item["row"]) for item in payload["analysis"]["issues"]] == [
            ("bates_only_row", 2, 3)
        ]
        assert client.put(f"/api/v1/jobs/{job_id}/workflow", json={"workflow": workflow}).status_code == 200
        if workflow == "privilege_log":
            assert client.put(f"/api/v1/jobs/{job_id}/mapping", json={"columns": [
                {"id": "range", "name": "Bates Range", "source_fields": ["Begin Bates", "End Bates"],
                 "transform": {"kind": "shorten_bates"}},
                {"id": "privilege", "name": "Privilege", "source_fields": ["Redact", "Withhold"],
                 "transform": {"kind": "fill"}},
            ]}).status_code == 200
        assert client.post(f"/api/v1/jobs/{job_id}/review", json={}).status_code == 409
        acknowledged = ["bates_only_row"]
        assert client.post(f"/api/v1/jobs/{job_id}/review", json={
            "acknowledged_issue_codes": acknowledged,
        }).status_code == 202
        reviewed = _wait_job(client, job_id, {"ready_for_review", "failed"})
        assert reviewed["status"] == "ready_for_review"
        preview = client.get(f"/api/v1/jobs/{job_id}/preview").json()
        if workflow == "privilege_log":
            assert preview["rows"] == [["ABC0001-2", "Redact"], ["ABC0003-4", ""], ["ABC0005-6", ""]]
        else:
            assert preview["text"] == "RFP 01\r\nABC0001-2\r\n"
        assert client.post(f"/api/v1/jobs/{job_id}/finalize", json={
            "output_filename": "bates-only", "acknowledged_issue_codes": acknowledged,
            "review_token": reviewed["review_token"],
        }).status_code == 202
        assert _wait_job(client, job_id, {"complete", "failed"})["status"] == "complete"
        output = client.get(f"/api/v1/jobs/{job_id}/download").content
        if workflow == "privilege_log":
            assert output.decode("utf-8-sig") == (
                "Bates Range,Privilege\r\nABC0001-2,Redact\r\nABC0003-4,\r\nABC0005-6,\r\n"
            )
        else:
            assert output == b"RFP 01\r\nABC0001-2\r\n"
        receipt = client.get(f"/api/v1/jobs/{job_id}/receipt.json").json()
        assert receipt["issue_counts"] == {"bates_only_row": 2}
        assert receipt["acknowledged_issue_codes"] == acknowledged


def test_personal_data_findings_do_not_block_normalized_privilege_finalization() -> None:
    source = CORPUS / "generated/logikcull/privilege/valid/lc_privilege_feature_personal_data_normalization.csv"
    with TestClient(app) as client, source.open("rb") as handle:
        created = client.post("/api/v1/jobs").json()
        job_id = created["job_id"]
        uploaded = client.put(
            f"/api/v1/jobs/{job_id}/source",
            content=handle.read(),
            headers={"Content-Type": "text/csv", "X-File-Name": source.name},
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


def test_raw_upload_streams_and_multipart_is_rejected_early() -> None:
    original_limit = store.max_bytes
    try:
        store.max_bytes = 1024 * 1024
        with TestClient(app) as client:
            job_id = client.post("/api/v1/jobs").json()["job_id"]
            content = b"Begin Bates,End Bates,Tag: RFP 01\nABC0001,ABC0002,TRUE\n"
            uploaded = client.put(
                f"/api/v1/jobs/{job_id}/source",
                content=content,
                headers={"Content-Type": "text/csv", "X-File-Name": "sample.csv"},
            )
            assert uploaded.status_code == 202
            assert _wait_job(client, job_id, {"needs_configuration", "failed"})["status"] == "needs_configuration"
            assert (store.root / job_id / "source.csv").read_bytes() == content

            too_large_id = client.post("/api/v1/jobs").json()["job_id"]
            rejected = client.put(
                f"/api/v1/jobs/{too_large_id}/source",
                content=b"x" * (1024 * 1024 + 1),
                headers={"Content-Type": "text/csv", "X-File-Name": "large.csv"},
            )
            assert rejected.status_code == 413
            assert not (store.root / too_large_id / "source.partial").exists()
            assert client.get(f"/api/v1/jobs/{too_large_id}").json()["status"] == "awaiting_upload"

            multipart_id = client.post("/api/v1/jobs").json()["job_id"]
            rejected_multipart = client.put(
                f"/api/v1/jobs/{multipart_id}/source",
                files={"file": ("sample.csv", content, "text/csv")},
            )
            assert rejected_multipart.status_code == 415
            assert client.get(f"/api/v1/jobs/{multipart_id}").json()["status"] == "awaiting_upload"
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


@pytest.mark.parametrize(
    "headers,platform",
    [
        ("Bates/Control #,End Bates/Control #", "logikcull"),
        ("Begin Bates Num from Production,End Bates Num from Production", "everlaw"),
        ("Begin Bates,End Bates", "unknown"),
    ],
)
@pytest.mark.parametrize("enabled", [True, False])
def test_legacy_http_mapping_and_mixed_request_rejection(headers: str, platform: str, enabled: bool) -> None:
    metadata_header = ",Author" if platform == "logikcull" else ""
    metadata_value = ",Synthetic reviewer" if platform == "logikcull" else ""
    source = (headers + ",Tag: Attorney Client" + metadata_header
              + "\nSYN_1,SYN_1,TRUE" + metadata_value + "\n").encode()
    column = {"id": "flag", "name": "Reason", "source_fields": ["Tag: Attorney Client"]}
    legacy = {"columns": [column], "replace_true_with_header": enabled}
    with TestClient(app) as client:
        job_id, _ = _create_and_upload(client, "synthetic-flags.csv", source)
        endpoint = f"/api/v1/jobs/{job_id}"
        assert client.get(endpoint).json()["analysis"]["platform"] == platform
        client.put(endpoint + "/workflow", json={"workflow": "privilege_log"}).raise_for_status()
        saved = client.put(endpoint + "/mapping", json=legacy)
        saved.raise_for_status()
        assert "replace_true_with_header" not in saved.json()["mapping"]
        assert saved.json()["mapping"]["columns"][0]["replace_true_with_header"] is (
            enabled and platform == "logikcull"
        )
        assert client.post(endpoint + "/mapping/blank-cells", json=legacy).json()["blank_cells"] == [0]
        ambiguous = {**legacy, "columns": [{**column, "replace_true_with_header": False}]}
        for method, suffix in (("put", "/mapping"), ("post", "/mapping/blank-cells")):
            response = getattr(client, method)(endpoint + suffix, json=ambiguous)
            assert response.status_code == 422
            assert "Reload the application" in response.text
        assert client.get(endpoint).json()["configuration_revision"] == saved.json()["configuration_revision"]
        mixed = {
            "columns": [
                {**column, "replace_true_with_header": True},
                {**column, "id": "raw", "name": "Raw", "replace_true_with_header": False},
            ]
        }
        updated = client.put(endpoint + "/mapping", json=mixed)
        updated.raise_for_status()
        assert [item["replace_true_with_header"] for item in updated.json()["mapping"]["columns"]] == [True, False]
