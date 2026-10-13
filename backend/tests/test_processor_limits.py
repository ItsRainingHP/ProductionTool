# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Boundary CSVs and output-limit failures for the processor."""

from __future__ import annotations

import sqlite3
import tracemalloc
from pathlib import Path

import pytest
from pydantic import ValidationError

from app import processor
from app.models import Issue, MappingConfig, OutputColumn, PleadingSettings
from app.processor import ProcessingLimitError, analyze_csv, build_preview, write_output


def source_file(tmp_path: Path, name: str, contents: str) -> Path:
    source = tmp_path / name
    source.write_text(contents, encoding="utf-8")
    return source


def privilege_mapping() -> MappingConfig:
    return MappingConfig.model_validate({"columns": [{
        "id": "author", "name": "Author", "source_fields": ["Author"],
        "transform": {"kind": "none", "delimiter": None},
    }]})


def test_unrecognized_headers_dates_and_free_text_request_labels() -> None:
    assert processor.detect_platform(["", "  "]) == ("unknown", 0)
    assert processor.is_date_of_birth("not a date") is False
    assert processor.request_labels_from_cell("Initial request; RFP 3; commentary") == [
        "Initial request", "RFP 03; commentary",
    ]
    assert processor.request_labels_from_cell("Custom request; supplemental") == ["Custom request; supplemental"]
    assert processor.request_labels_from_cell("RFP 1; supplemental, ROG 2: urgent") == [
        "RFP 01; supplemental", "ROG 02: urgent",
    ]
    issues = processor._collapse_issues([
        Issue(code="uneven_row_width", severity="warning", message="Uneven", row=None, column="Author"),
        Issue(code="uneven_row_width", severity="warning", message="Uneven", row=3, column="Author"),
        Issue(code="blank_header", severity="error", message="Blank", row=1),
    ])
    assert [(issue.code, issue.count, issue.row) for issue in issues] == [
        ("uneven_row_width", 2, 3), ("blank_header", 1, 1),
    ]


def test_incomplete_utf8_and_undefined_cp1252_bytes_are_reported(tmp_path: Path) -> None:
    truncated = tmp_path / "truncated.csv"
    truncated.write_bytes(b"A\n\xc3")
    assert analyze_csv(truncated, truncated.name).row_count == 1
    undefined = tmp_path / "undefined.csv"
    undefined.write_bytes(b"A\n\x81")
    assert "invalid_utf8" in {issue.code for issue in analyze_csv(undefined, undefined.name).issues}
    bom_only = tmp_path / "bom.csv"
    bom_only.write_bytes(b"\xef\xbb\xbf")
    assert "empty_file" in {issue.code for issue in analyze_csv(bom_only, bom_only.name).issues}


def test_cp1252_marker_bytes_inside_file_are_data(tmp_path: Path) -> None:
    source = tmp_path / "cp1252.csv"
    source.write_bytes("Begin Bates,End Bates,RFP\nABC_1,ABC_2,Custom ÿþ note\n".encode("cp1252"))
    analysis = analyze_csv(source, source.name)
    assert "invalid_utf8" not in {issue.code for issue in analysis.issues}
    output = tmp_path / "output.txt"
    stats = write_output(output, source, analysis, "rfp_ranges", None, 0)
    assert stats.output_rows == 1
    assert output.read_text(encoding="utf-8").startswith("Custom ÿþ note\nABC_1-2")


def test_numbered_request_qualifier_survives_analysis_and_output(tmp_path: Path) -> None:
    source = source_file(tmp_path, "qualified.csv", "Begin Bates,End Bates,RFP\n"
                         'ABC_1,ABC_2,"RFP 01; supplemental, ROG 02: urgent"\n')
    analysis = analyze_csv(source, source.name)
    assert analysis.request_count == 2
    output = tmp_path / "qualified.txt"
    write_output(output, source, analysis, "rfp_ranges", None, 0)
    text = output.read_text(encoding="utf-8")
    assert "RFP 01; supplemental\nABC_1-2" in text
    assert "ROG 02: urgent\nABC_1-2" in text


def test_rfp_preview_reads_only_bounded_staged_characters(tmp_path: Path) -> None:
    source = source_file(tmp_path, "small.csv", "Begin Bates,End Bates,RFP\nABC_1,ABC_2,RFP 01\n")
    analysis = analyze_csv(source, source.name)
    staged = tmp_path / "staged.txt"
    stats = write_output(staged, source, analysis, "rfp_ranges", None, 0)
    staged.write_text("é" * (8 * 1024 * 1024), encoding="utf-8")
    tracemalloc.start()
    try:
        preview = processor.build_artifact_preview(
            staged, "rfp_ranges", stats, artifact_sha256="a" * 64,
            configuration_revision=1, review_token="b" * 64,
        )
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert preview.text == "é" * 5_000
    assert preview.sample_truncated is True
    assert peak < 2 * 1024 * 1024


def test_six_hundred_thousand_rfp_rows_use_job_scratch(tmp_path: Path) -> None:
    source = tmp_path / "large.csv"
    with source.open("w", encoding="utf-8", newline="") as handle:
        handle.write("Begin Bates,End Bates,RFP\n")
        for number in range(600_000):
            value = number * 2 + 1
            handle.write(f"ABC_{value:07d},ABC_{value:07d},RFP 01\n")
    job_dir = tmp_path / "job"
    job_dir.mkdir()
    scratch = job_dir / "scratch"
    analysis = analyze_csv(source, source.name, scratch_dir=scratch, max_work_bytes=512 * 1024 * 1024)
    assert analysis.row_count == 600_000
    assert not list(scratch.iterdir())
    output = job_dir / "staged.txt"
    stats = write_output(output, source, analysis, "rfp_ranges", None, 0,
                         max_work_bytes=512 * 1024 * 1024, scratch_dir=scratch)
    assert stats.output_rows == 600_000
    assert output.stat().st_size > 7 * 1024 * 1024
    assert not list(scratch.iterdir())


def test_analysis_spool_limit_cleans_job_scratch(tmp_path: Path) -> None:
    source = source_file(tmp_path, "ranges.csv", "Begin Bates,End Bates,RFP\nABC_1,ABC_1,RFP 01\n")
    scratch = tmp_path / "job" / "scratch"
    with pytest.raises(sqlite3.DatabaseError, match="full"):
        analyze_csv(source, source.name, scratch_dir=scratch, max_work_bytes=1)
    assert not list(scratch.iterdir())


def test_duplicate_and_missing_required_bates_headers(tmp_path: Path) -> None:
    source = source_file(tmp_path, "headers.csv", "End Bates,End Bates,RFP\nABC_2,ABC_3,RFP 01\n")
    issues = {issue.code for issue in analyze_csv(source, source.name).issues}
    assert "missing_begin_bates_column" in issues
    assert "conflicting_required_columns" in issues
    missing_end = source_file(tmp_path, "missing-end.csv", "Begin Bates,RFP\nABC_1,RFP 01\n")
    assert "missing_end_bates_column" in {issue.code for issue in analyze_csv(missing_end, missing_end.name).issues}


def test_missing_bates_mapping_and_empty_privilege_output(tmp_path: Path) -> None:
    source = source_file(tmp_path, "contacts.csv", "Author\n")
    analysis = analyze_csv(source, source.name)
    empty = build_preview(source, analysis, "privilege_log", None)
    assert empty.rows == [] and empty.total_rows == 0
    with pytest.raises(ValueError, match="mapping is required"):
        write_output(tmp_path / "missing.csv", source, analysis, "privilege_log", None, 0)
    with pytest.raises(ProcessingLimitError, match="no recoverable output rows"):
        write_output(tmp_path / "empty.csv", source, analysis, "privilege_log", privilege_mapping(), 0)
    assert not (tmp_path / "empty.csv").exists()

    rfp_source = source_file(tmp_path, "rfp.csv", "Request\nRFP 01\n")
    no_bates = analyze_csv(rfp_source, rfp_source.name)
    connection, skipped = processor._populate_rfp_spool(rfp_source, no_bates, tmp_path / "missing-bates.sqlite")
    try:
        assert skipped == no_bates.row_count
        assert connection.execute("SELECT COUNT(*) FROM ranges").fetchone()[0] == 0
    finally:
        connection.close()


def test_output_limits_and_sqlite_full_are_controlled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = source_file(tmp_path, "rfp.csv", "Begin Bates,End Bates,RFP\nABC_1,ABC_2,RFP 01\nABC_5,ABC_6,RFP 01\n")
    analysis = analyze_csv(source, source.name)
    output = tmp_path / "ranges.txt"
    stats = write_output(output, source, analysis, "rfp_ranges", None, 0, PleadingSettings())
    assert stats.output_rows == 2
    assert " and " in output.read_text(encoding="utf-8")

    real_spool = processor._populate_rfp_spool
    monkeypatch.setattr(processor, "_populate_rfp_spool", lambda path, analyzed, database, max_bytes:
                        real_spool(path, analyzed, database, None))
    with pytest.raises(ProcessingLimitError, match="per-job work limit"):
        write_output(output, source, analysis, "rfp_ranges", None, 0, max_work_bytes=1)
    assert not output.exists()

    def full_spool(*_args):
        raise sqlite3.DatabaseError("database or disk is full")

    monkeypatch.setattr(processor, "_populate_rfp_spool", full_spool)
    with pytest.raises(ProcessingLimitError, match="scratch-space limit"):
        write_output(output, source, analysis, "rfp_ranges", None, 0)
    monkeypatch.setattr(
        processor, "_populate_rfp_spool", lambda *_args: (_ for _ in ()).throw(sqlite3.DatabaseError("broken"))
    )
    with pytest.raises(sqlite3.DatabaseError, match="broken"):
        write_output(output, source, analysis, "rfp_ranges", None, 0)

    contacts = source_file(tmp_path, "contacts.csv", "Author\nTaylor\n")
    with pytest.raises(ProcessingLimitError, match="per-job work limit"):
        write_output(tmp_path / "tiny.csv", contacts, analyze_csv(contacts, contacts.name),
                     "privilege_log", privilege_mapping(), 0, max_work_bytes=1)


def test_rfp_with_no_recoverable_rows_is_not_written(tmp_path: Path) -> None:
    source = source_file(tmp_path, "bad-ranges.csv", "Begin Bates,End Bates,RFP\nABC_4,ABC_1,RFP 01\n")
    analysis = analyze_csv(source, source.name)
    output = tmp_path / "empty.txt"
    with pytest.raises(ProcessingLimitError, match="no recoverable output rows"):
        write_output(output, source, analysis, "rfp_ranges", None, 0)
    assert not output.exists()


@pytest.mark.parametrize(("name", "fields", "message"), [
    ("  ", ["Author"], "cannot be blank"),
    ("Bad\nname", ["Author"], "control characters"),
    ("Author", ["Author", "Author"], "only appear once"),
])
def test_output_column_rejects_unsafe_names_and_duplicate_sources(
    name: str, fields: list[str], message: str,
) -> None:
    with pytest.raises(ValidationError, match=message):
        OutputColumn.model_validate({"id": "author", "name": name, "source_fields": fields,
                                     "transform": {"kind": "fill"}})
