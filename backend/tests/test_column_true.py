"""Independent per-output TRUE replacement and legacy mapping compatibility regressions."""

import csv
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.models import Analysis, JobView, MappingConfig, MappingRequest, migrate_legacy_mapping
from app.processor import build_preview, count_privilege_blank_cells, iter_privilege_output_rows, write_output


@pytest.mark.parametrize("platform", ["logikcull", "everlaw", "unknown"])
def test_independent_outputs_reuse_inputs_on_every_platform(tmp_path: Path, platform: str) -> None:
    source = tmp_path / "flags.csv"
    source.write_text(
        "Subject,Tag: ATTORNEY CLIENT,Tag: Work Product\n"
        "Re: True-up calculation for Q3, TrUe ,TRUE\n"
        "Is this statement true?,FALSE,(TRUE)\n"
        "True copy of signed agreement,true,true-ish\n",
        encoding="utf-8",
    )
    original = source.read_bytes()
    mapping = MappingConfig.model_validate(
        {
            "columns": [
                {"id": "subject", "name": "Subject", "source_fields": ["Subject"], "replace_true_with_header": True},
                {"id": "raw", "name": "Raw flag", "source_fields": ["Tag: ATTORNEY CLIENT"]},
                {
                    "id": "on",
                    "name": "Reason",
                    "source_fields": ["Tag: ATTORNEY CLIENT"],
                    "replace_true_with_header": True,
                    "normalize": True,
                },
                {
                    "id": "join",
                    "name": "Joined",
                    "source_fields": ["Tag: ATTORNEY CLIENT", "Tag: Work Product"],
                    "replace_true_with_header": True,
                    "transform": {"kind": "delimit", "delimiter": "; "},
                },
                {
                    "id": "fill",
                    "name": "Fill",
                    "source_fields": ["Tag: Work Product", "Tag: ATTORNEY CLIENT"],
                    "replace_true_with_header": True,
                    "transform": {"kind": "fill"},
                },
            ]
        }
    )
    analysis = Analysis(filename=source.name, size_bytes=source.stat().st_size, platform=platform)
    expected = [
        [
            "Re: True-up calculation for Q3",
            " TrUe ",
            "Attorney Client",
            "ATTORNEY CLIENT; Work Product",
            "Work Product",
        ],
        ["Is this statement true?", "FALSE", "False", "FALSE; (TRUE)", "(TRUE)"],
        ["True copy of signed agreement", "true", "Attorney Client", "ATTORNEY CLIENT; true-ish", "true-ish"],
    ]
    assert list(iter_privilege_output_rows(source, mapping, analysis)) == expected
    assert list(iter_privilege_output_rows(source, mapping)) == expected
    assert count_privilege_blank_cells(source, mapping, analysis).blank_cells == [0] * 5
    preview = build_preview(source, analysis, "privilege_log", mapping)
    output = tmp_path / "output.csv"
    write_output(output, source, analysis, "privilege_log", mapping, 0)
    with output.open(encoding="utf-8-sig", newline="") as handle:
        assert list(csv.reader(handle))[1:] == preview.rows == expected
    assert source.read_bytes() == original


@pytest.mark.parametrize("platform", ["logikcull", "everlaw", "unknown"])
@pytest.mark.parametrize("enabled", [True, False])
def test_legacy_request_adapter_preserves_old_effective_behavior(platform: str, enabled: bool) -> None:
    request = MappingRequest.model_validate(
        {
            "replace_true_with_header": enabled,
            "columns": [
                {"id": "flag", "name": "Flag", "source_fields": ["Flag"]},
                {
                    "id": "range",
                    "name": "Range",
                    "source_fields": ["Begin", "End"],
                    "transform": {"kind": "shorten_bates"},
                },
            ],
        }
    )
    mapping = request.to_config(platform)
    assert [column.replace_true_with_header for column in mapping.columns] == [
        enabled and platform == "logikcull",
        False,
    ]
    assert "replace_true_with_header" not in mapping.model_dump()
    assert "replace_true_with_header" not in request.model_dump()


def test_request_defaults_and_conflicting_settings() -> None:
    column = {"id": "flag", "name": "Flag", "source_fields": ["Flag"]}
    assert not MappingRequest(columns=[column]).to_config("logikcull").columns[0].replace_true_with_header
    for legacy in (True, False, None):
        with pytest.raises(ValidationError, match="Reload the application"):
            MappingRequest.model_validate(
                {
                    "replace_true_with_header": legacy,
                    "columns": [
                        {**column, "replace_true_with_header": False},
                    ],
                }
            )
    with pytest.raises(ValidationError, match="Bates range"):
        MappingConfig.model_validate(
            {
                "columns": [
                    {
                        **column,
                        "source_fields": ["Begin", "End"],
                        "transform": {"kind": "shorten_bates"},
                        "replace_true_with_header": True,
                    }
                ]
            }
        )


@pytest.mark.parametrize("platform", ["logikcull", "everlaw", "unknown"])
@pytest.mark.parametrize("enabled", [True, False])
def test_legacy_job_payload_migration_is_idempotent(platform: str, enabled: bool) -> None:
    payload = {
        "job_id": "legacy",
        "created_at": "2026-11-02T00:00:00Z",
        "expires_at": "2099-01-01T00:00:00Z",
        "status": "needs_configuration",
        "progress": {},
        "analysis": {"filename": "test.csv", "size_bytes": 1, "platform": platform},
        "mapping": {
            "replace_true_with_header": enabled,
            "columns": [
                {"id": "flag", "name": "Flag", "source_fields": ["Flag"]},
                {
                    "id": "range",
                    "name": "Range",
                    "source_fields": ["Begin", "End"],
                    "transform": {"kind": "shorten_bates"},
                },
            ],
        },
    }
    job = JobView.model_validate(payload)
    assert job.mapping.columns[0].replace_true_with_header is (enabled and platform == "logikcull")
    assert job.mapping.columns[1].replace_true_with_header is False
    assert JobView.model_validate_json(job.model_dump_json()) == job
    assert payload["mapping"]["replace_true_with_header"] is enabled
    assert migrate_legacy_mapping(None, platform) is None
    assert migrate_legacy_mapping({"columns": "invalid"}, platform) == {"columns": "invalid"}
    assert migrate_legacy_mapping({"columns": [None]}, platform) == {"columns": [None]}


def test_legacy_unmarked_mapping_defaults_and_missing_analysis() -> None:
    column = {"id": "flag", "name": "Flag", "source_fields": ["Flag"]}
    assert migrate_legacy_mapping({"columns": [column]}, "logikcull")["columns"][0]["replace_true_with_header"]
    job = JobView(job_id="unmapped", created_at="now", expires_at="later", status="needs_configuration", progress={})
    assert job.mapping is None
    assert (
        JobView.model_validate({**job.model_dump(), "mapping": {"columns": [column]}})
        .mapping.columns[0]
        .replace_true_with_header
        is False
    )
