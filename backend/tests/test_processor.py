# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Unit and corpus-backed tests for CSV analysis and output processing."""

from __future__ import annotations

import csv
import json
import time
from pathlib import Path

import pytest

from app.models import MappingConfig, PleadingSettings
from app.processor import (
    analyze_csv,
    build_artifact_preview,
    build_preview,
    count_privilege_blank_cells,
    detect_platform,
    escape_formula,
    iter_privilege_output_rows,
    normalize_contact_value,
    personal_data_matches,
    render_rfp_text,
    rfp_output_rows,
    shorten_bates,
    write_output,
)

CORPUS = Path(__file__).resolve().parents[2] / "examples"
MANIFEST = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))


def classify(analysis) -> str:
    if any(issue.severity == "fatal" for issue in analysis.issues):
        return "parse_error"
    if any(issue.severity in {"warning", "error"} for issue in analysis.issues):
        return "validation_error"
    return "valid"


@pytest.mark.parametrize("fixture", MANIFEST["fixtures"], ids=lambda item: item["id"])
def test_manifest_classification_and_errors(fixture: dict) -> None:
    path = CORPUS / fixture["path"]
    analysis = analyze_csv(path, path.name)
    assert classify(analysis) == fixture["expectedStatus"]
    actual_codes = {issue.code for issue in analysis.issues}
    assert set(fixture["expectedErrors"]) <= actual_codes
    assert [finding.model_dump() for finding in analysis.personal_data_findings] == fixture.get(
        "expectedPersonalDataFindings", []
    )


@pytest.mark.parametrize(
    "fixture",
    [item for item in MANIFEST["fixtures"] if item["expectedStatus"] == "valid"],
    ids=lambda item: f"platform-{item['id']}",
)
def test_valid_corpus_platform_confidence(fixture: dict) -> None:
    path = CORPUS / fixture["path"]
    analysis = analyze_csv(path, path.name)
    assert analysis.platform == fixture["platform"]
    assert analysis.platform_confidence >= 80


def test_platform_detection_normalizes_case_whitespace_and_order() -> None:
    headers = ["Bates/Control #", "End Bates/Control #", "Author", "Date Sent"]
    transformed = ["  DATE   SENT ", " author ", " END BATES/CONTROL # ", "bAtEs/CoNtRoL #"]
    assert detect_platform(headers) == detect_platform(transformed) == ("logikcull", 84)


def test_platform_detection_partial_ambiguous_and_generic_headers() -> None:
    assert detect_platform(["Bates/Control #"]) == ("unknown", 40)
    assert detect_platform(["Bates/Control #", "End Bates/Control #"]) == ("logikcull", 80)
    mixed = [
        "Bates/Control #",
        "End Bates/Control #",
        "Begin Bates num from MATTER",
        "End Bates num from MATTER",
    ]
    assert detect_platform(mixed) == ("unknown", 40)
    assert detect_platform(["Begin Bates", "End Bates", "RFP"]) == ("unknown", 0)


def test_platform_detection_ignores_filename(tmp_path: Path) -> None:
    content = "Bates/Control #,End Bates/Control #,Author\nTEST_0001,TEST_0002,Person\n"
    first = tmp_path / "everlaw_named_file.csv"
    second = tmp_path / "unrelated.csv"
    first.write_text(content, encoding="utf-8")
    second.write_text(content, encoding="utf-8")
    first_analysis = analyze_csv(first, first.name)
    second_analysis = analyze_csv(second, second.name)
    assert (
        (first_analysis.platform, first_analysis.platform_confidence)
        == (
            second_analysis.platform,
            second_analysis.platform_confidence,
        )
        == ("logikcull", 82)
    )


def test_platform_confidence_for_unreadable_and_fatal_files(tmp_path: Path) -> None:
    empty = tmp_path / "empty.csv"
    empty.write_bytes(b"")
    assert (analyze_csv(empty, empty.name).platform, analyze_csv(empty, empty.name).platform_confidence) == (
        "unknown",
        0,
    )

    invalid_utf8 = tmp_path / "invalid.csv"
    invalid_utf8.write_bytes(b"Bates/Control #,End Bates/Control #\n\xff")
    invalid_analysis = analyze_csv(invalid_utf8, invalid_utf8.name)
    assert (invalid_analysis.platform, invalid_analysis.platform_confidence) == ("logikcull", 80)

    malformed = tmp_path / "malformed.csv"
    malformed.write_text('Bates/Control #,End Bates/Control #\n"TEST_0001,TEST_0002\n', encoding="utf-8")
    malformed_analysis = analyze_csv(malformed, malformed.name)
    assert (malformed_analysis.platform, malformed_analysis.platform_confidence) == ("logikcull", 80)
    assert any(issue.severity == "fatal" for issue in malformed_analysis.issues)


@pytest.mark.parametrize(
    "fixture",
    [item for item in MANIFEST["fixtures"] if item["expectedStatus"] == "valid" and item["dataType"] == "pleading"],
    ids=lambda item: item["id"],
)
def test_rfp_ranges_match_manifest(fixture: dict) -> None:
    path = CORPUS / fixture["path"]
    analysis = analyze_csv(path, path.name)
    _, rows, skipped = rfp_output_rows(path, analysis)
    actual: dict[str, list[dict[str, str]]] = {}
    for request, begin, end in rows:
        actual.setdefault(request, []).append({"begin": begin, "end": end})
    assert skipped == 0
    assert actual == fixture["expectedRfpRanges"]


def test_bates_shortening() -> None:
    assert shorten_bates("TEST_000001", "TEST_001234") == "TEST_000001-1234"
    assert shorten_bates("TEST_001293", "TEST_001294") == "TEST_001293-1294"
    assert shorten_bates("TEST_013473", "TEST_015869") == "TEST_013473-15869"
    assert shorten_bates("TEST_13473", "TEST_15869") == "TEST_13473-15869"
    assert shorten_bates("TEST_100000", "TEST_100001") == "TEST_100000-100001"
    assert shorten_bates("TEST_000001", "TEST_000001") == "TEST_000001"
    assert shorten_bates("A0001", "B0002") == "A0001-B0002"


def test_large_end_bates_ranges_in_pleading_preview_and_download(tmp_path: Path) -> None:
    source = CORPUS / "generated/logikcull/pleading/valid/lc_pleading_feature_large_end_ranges.csv"
    analysis = analyze_csv(source, source.name)
    assert classify(analysis) == "valid"
    assert analysis.detected_workflow == "rfp_ranges"

    _, rows, skipped = rfp_output_rows(source, analysis)
    assert skipped == 0
    assert rows == [
        ["RFP 01", "SYNBATES_013473", "SYNBATES_015869"],
        ["RFP 02", "SYNBATES_13473", "SYNBATES_15869"],
        ["RFP 03", "SYNBATES_100000", "SYNBATES_100001"],
        ["RFP 04", "SYNBATES_001293", "SYNBATES_001294"],
    ]
    expected_text = (
        "RFP 01\r\nSYNBATES_013473-15869\r\n\r\n"
        "RFP 02\r\nSYNBATES_13473-15869\r\n\r\n"
        "RFP 03\r\nSYNBATES_100000-100001\r\n\r\n"
        "RFP 04\r\nSYNBATES_001293-1294\r\n"
    )
    preview = build_preview(source, analysis, "rfp_ranges", None)
    assert preview.text == expected_text
    assert preview.rows == [
        ["RFP 01", "SYNBATES_013473-15869"],
        ["RFP 02", "SYNBATES_13473-15869"],
        ["RFP 03", "SYNBATES_100000-100001"],
        ["RFP 04", "SYNBATES_001293-1294"],
    ]

    output = tmp_path / "ranges.txt"
    stats = write_output(output, source, analysis, "rfp_ranges", None, 0)
    assert stats.output_rows == 4
    assert output.read_bytes() == expected_text.encode("utf-8")
    assert (
        build_artifact_preview(
            output, "rfp_ranges", stats, artifact_sha256="a" * 64, configuration_revision=1, review_token="b" * 64
        ).text
        == expected_text
    )


def test_privilege_blank_counts_follow_output_transforms(tmp_path: Path) -> None:
    source = tmp_path / "privilege-blanks.csv"
    source.write_text(
        "Begin Bates,End Bates,Author,Recipient\n"
        "TEST0001,TEST0002,Alice,\n"
        "TEST0003,TEST0004,,Bob\n"
        "TEST0005,TEST0006,,  \n",
        encoding="utf-8",
    )
    mapping = MappingConfig.model_validate({"columns": [
        {"id": "direct", "name": "Author", "source_fields": ["Author"]},
        {"id": "fill", "name": "Best person", "source_fields": ["Author", "Recipient"],
         "transform": {"kind": "fill"}},
        {"id": "join", "name": "People", "source_fields": ["Author", "Recipient"],
         "transform": {"kind": "delimit", "delimiter": "; "}},
        {"id": "range", "name": "Range", "source_fields": ["Begin Bates", "End Bates"],
         "transform": {"kind": "shorten_bates"}},
    ]})

    report = count_privilege_blank_cells(source, mapping)
    assert report.output_rows == 3
    assert report.blank_cells == [2, 1, 1, 0]


@pytest.mark.parametrize("enabled", [True, False])
@pytest.mark.parametrize(("value", "is_true"), [
    ("TRUE", True),
    ("true", True),
    ("TrUe", True),
    ("  true  ", True),
    ("\tTrUe\r\n", True),
    ("\u00a0TRUE\u00a0", True),
    ("Re: True-up calculation for Q3", False),
    ("Is this statement true?", False),
    ("True copy of signed agreement", False),
    ("Contains a TRUE marker", False),
    ("(TRUE)", False),
    ('"TRUE"', False),
    ("TRUE-ish", False),
    ("not TRUE.", False),
    ("TRUE, FALSE", False),
    ("TRUE\nnotes", False),
    ("TRUETYPE", False),
    ("untrue", False),
    ("TRUE_value", False),
    ("FALSE", False),
    ("", False),
    ("   ", False),
])
def test_logikcull_replaces_only_entire_true_cells(
    tmp_path: Path, enabled: bool, value: str, is_true: bool,
) -> None:
    source = tmp_path / "whole-cell-true.csv"
    with source.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Bates/Control #", "End Bates/Control #", "Subject", "Tag: Attorney Client", "Fallback"])
        writer.writerow(["SYN_000001", "SYN_000001", value, value, "Fallback text"])
    original = source.read_bytes()
    analysis = analyze_csv(source, source.name)
    assert analysis.platform == "logikcull"
    mapping = MappingConfig.model_validate({"replace_true_with_header": enabled, "columns": [
        {"id": "subject", "name": "Subject", "source_fields": ["Subject"]},
        {"id": "flag", "name": "Flag", "source_fields": ["Tag: Attorney Client"]},
        {"id": "join", "name": "Join", "source_fields": ["Subject", "Tag: Attorney Client"],
         "transform": {"kind": "delimit", "delimiter": "; "}},
        {"id": "fill", "name": "Fill", "source_fields": ["Subject", "Fallback"],
         "transform": {"kind": "fill"}},
    ]})
    subject, flag = ("Subject", "Attorney Client") if enabled and is_true else (value, value)
    expected = [[subject, flag, f"{subject}; {flag}" if value.strip() else "",
                 subject if value.strip() else "Fallback text"]]
    assert list(iter_privilege_output_rows(source, mapping, analysis)) == expected
    assert count_privilege_blank_cells(source, mapping, analysis).blank_cells == (
        [0, 0, 0, 0] if value.strip() else [1, 1, 1, 0]
    )
    assert build_preview(source, analysis, "privilege_log", mapping).rows == expected
    output = tmp_path / "output.csv"
    write_output(output, source, analysis, "privilege_log", mapping, 0)
    with output.open(encoding="utf-8-sig", newline="") as handle:
        assert list(csv.reader(handle))[1:] == expected
    assert source.read_bytes() == original


def test_logikcull_true_markers_use_headers_in_direct_and_join(tmp_path: Path) -> None:
    source = CORPUS / "generated/logikcull/privilege/valid/lc_privilege_feature_true_blank_flags.csv"
    analysis = analyze_csv(source, source.name)
    assert analysis.platform == "logikcull"
    assert analysis.true_blank_headers == ["Attorney Client", "Work Product"]
    mapping = MappingConfig.model_validate({"columns": [
        {"id": "direct", "name": "Direct", "source_fields": ["Attorney Client"]},
        {"id": "join", "name": "Joined", "source_fields": ["Attorney Client", "Work Product"],
         "transform": {"kind": "delimit", "delimiter": "; "}},
        {"id": "mixed", "name": "Mixed Notes", "source_fields": ["Mixed Notes"]},
        {"id": "empty", "name": "Empty Flag", "source_fields": ["Empty Flag"]},
    ]})
    expected = [
        ["Attorney Client", "Attorney Client", "Mixed Notes", ""],
        ["", "Work Product", "Contains a TRUE marker", ""],
        ["Attorney Client", "Attorney Client; Work Product", "Mixed Notes", ""],
    ]
    assert list(iter_privilege_output_rows(source, mapping, analysis)) == expected
    assert build_preview(source, analysis, "privilege_log", mapping).rows == expected
    assert count_privilege_blank_cells(source, mapping, analysis).blank_cells == [1, 0, 0, 3]

    output = tmp_path / "privilege-output.csv"
    write_output(output, source, analysis, "privilege_log", mapping, 0)
    with output.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.reader(handle))
    assert rows == [["Direct", "Joined", "Mixed Notes", "Empty Flag"], *expected]


def test_true_blank_header_conversion_depends_on_source_platform(tmp_path: Path) -> None:
    source = tmp_path / "everlaw-privilege.csv"
    source.write_text(
        "Begin Bates num from SYNTHETIC,End Bates num from SYNTHETIC,Attorney Client\n"
        "SYN_0001,SYN_0001,TRUE\n",
        encoding="utf-8",
    )
    analysis = analyze_csv(source, source.name)
    assert analysis.platform == "everlaw"
    assert analysis.true_blank_headers == []
    mapping = MappingConfig.model_validate({"columns": [
        {"id": "direct", "name": "Direct", "source_fields": ["Attorney Client"]}
    ]})
    assert list(iter_privilege_output_rows(source, mapping, analysis)) == [["TRUE"]]

    logikcull = tmp_path / "logikcull-with-rfp.csv"
    logikcull.write_text(
        "Bates/Control #,End Bates/Control #,RFP: RFP 01,Attorney Client\n"
        "SYN_0001,SYN_0001,TRUE,TRUE\n",
        encoding="utf-8",
    )
    logikcull_analysis = analyze_csv(logikcull, logikcull.name)
    assert logikcull_analysis.detected_workflow == "rfp_ranges"
    assert logikcull_analysis.true_blank_headers == ["RFP: RFP 01", "Attorney Client"]
    assert list(iter_privilege_output_rows(logikcull, mapping, logikcull_analysis)) == [["Attorney Client"]]
    for platform in ("everlaw", "unknown"):
        other_analysis = logikcull_analysis.model_copy(update={"platform": platform})
        assert list(iter_privilege_output_rows(logikcull, mapping, other_analysis)) == [["TRUE"]]


def test_true_replacement_affects_blank_counts_and_fill_before_selection(tmp_path: Path) -> None:
    source = tmp_path / "blank-heading.csv"
    source.write_text(
        "Bates/Control #,End Bates/Control #,Tag:,Fallback\nEXAMPLE_1,EXAMPLE_2,TRUE,Other\n", encoding="utf-8",
    )
    analysis = analyze_csv(source, source.name)
    mapping = MappingConfig.model_validate({"columns": [
        {"id": "direct", "name": "Direct", "source_fields": ["Tag:"]},
        {"id": "fill", "name": "Fill", "source_fields": ["Tag:", "Fallback"], "transform": {"kind": "fill"}},
    ]})
    assert list(iter_privilege_output_rows(source, mapping, analysis)) == [["", "Other"]]
    assert count_privilege_blank_cells(source, mapping, analysis).blank_cells == [1, 0]
    mapping.replace_true_with_header = False
    assert list(iter_privilege_output_rows(source, mapping, analysis)) == [["TRUE", "TRUE"]]
    assert count_privilege_blank_cells(source, mapping, analysis).blank_cells == [0, 0]


@pytest.mark.parametrize("enabled", [True, False])
def test_true_replacement_precedes_direct_join_fill_and_normalization(tmp_path: Path, enabled: bool) -> None:
    source = tmp_path / "true-markers.csv"
    source.write_text(
        'Bates/Control #,End Bates/Control #,Tag: ATTORNEY CLIENT,tag: Work Product,Other,Tag: =Formula\n'
        'EXAMPLE_000001,EXAMPLE_000092,TrUe,TRUE,fallback,TRUE\n'
        'EXAMPLE_000093,EXAMPLE_000094,TRUETYPE,FALSE,,\n'
        'EXAMPLE_000095,EXAMPLE_000096,,  true  ,last,\n',
        encoding="utf-8",
    )
    original = source.read_bytes()
    analysis = analyze_csv(source, source.name)
    assert analysis.platform == "logikcull"
    mapping = MappingConfig.model_validate({"replace_true_with_header": enabled, "columns": [
        {"id": "direct", "name": "Direct", "source_fields": ["Tag: ATTORNEY CLIENT"]},
        {"id": "join", "name": "Join", "source_fields": ["Tag: ATTORNEY CLIENT", "tag: Work Product"],
         "transform": {"kind": "delimit", "delimiter": "; "}},
        {"id": "fill", "name": "Fill", "source_fields": ["Tag: ATTORNEY CLIENT", "tag: Work Product", "Other"],
         "transform": {"kind": "fill"}},
        {"id": "normalized", "name": "Normalized", "source_fields": ["Tag: ATTORNEY CLIENT"], "normalize": True},
        {"id": "formula", "name": "Formula", "source_fields": ["Tag: =Formula"]},
        {"id": "range", "name": "Range", "source_fields": ["Bates/Control #", "End Bates/Control #"],
         "transform": {"kind": "shorten_bates"}},
    ]})
    rows = list(iter_privilege_output_rows(source, mapping, analysis))
    if enabled:
        assert rows[0] == ["ATTORNEY CLIENT", "ATTORNEY CLIENT; Work Product", "ATTORNEY CLIENT",
                           "Attorney Client", "=Formula", "EXAMPLE_000001-92"]
        assert rows[2][1:3] == ["Work Product", "Work Product"]
    else:
        assert rows[0][:3] == ["TrUe", "TrUe; TRUE", "TrUe"]
        assert rows[0][4] == "TRUE"
        assert rows[2][1:3] == ["  true  ", "  true  "]
    assert rows[1][:3] == ["TRUETYPE", "TRUETYPE; FALSE", "TRUETYPE"]
    preview = build_preview(source, analysis, "privilege_log", mapping)
    output = tmp_path / "output.csv"
    stats = write_output(output, source, analysis, "privilege_log", mapping, 0)
    with output.open(encoding="utf-8-sig", newline="") as handle:
        written = list(csv.reader(handle))
    assert written[1:] == preview.rows
    assert stats.formula_escapes == int(enabled)
    assert written[1][4] == ("'=Formula" if enabled else "TRUE")
    assert source.read_bytes() == original


@pytest.mark.parametrize("end", [2, 9, 10, 92, 99, 100, 999, 1000, 1596, 9999, 10000, 100001])
@pytest.mark.parametrize("width", [1, 6, 12])
def test_bates_endings_are_unpadded_in_both_workflows(tmp_path: Path, end: int, width: int) -> None:
    source = tmp_path / "ranges.csv"
    begin_label = f"EXAMPLE_{1:0{width}d}"
    end_label = f"EXAMPLE_{end:0{width}d}"
    expected = f"EXAMPLE_{1:0{max(width, len(str(end)))}d}-{end}"
    assert shorten_bates(begin_label, end_label) == expected
    source.write_text(f"Bates/Control #,End Bates/Control #,RFP\n{begin_label},{end_label},RFP 1\n", encoding="utf-8")
    analysis = analyze_csv(source, source.name)
    mapping = MappingConfig.model_validate({"columns": [
        {"id": "range", "name": "Range", "source_fields": ["Bates/Control #", "End Bates/Control #"],
         "transform": {"kind": "shorten_bates"}},
    ]})
    for workflow in ("rfp_ranges", "privilege_log"):
        preview = build_preview(source, analysis, workflow, mapping)
        output = tmp_path / f"{workflow}.out"
        write_output(output, source, analysis, workflow, mapping, 0)
        if workflow == "rfp_ranges":
            assert preview.text == f"RFP 01\r\n{expected}\r\n"
            assert output.read_bytes() == preview.text.encode("utf-8")
        else:
            assert preview.rows == [[expected]]
            with output.open(encoding="utf-8-sig", newline="") as handle:
                assert list(csv.reader(handle)) == [["Range"], [expected]]


def test_privilege_preview_mapping() -> None:
    path = CORPUS / "reference-sanitized/logikcull/privilege/valid/lc_reference_privilege_001.csv"
    analysis = analyze_csv(path, path.name)
    mapping = MappingConfig.model_validate(
        {
            "columns": [
                {
                    "id": "range",
                    "name": "Bates Range",
                    "source_fields": ["Bates/Control #", "End Bates/Control #"],
                    "transform": {"kind": "shorten_bates"},
                },
                {
                    "id": "people",
                    "name": "People",
                    "source_fields": ["Author", "From", "To"],
                    "transform": {"kind": "delimit", "delimiter": "; "},
                },
            ]
        }
    )
    preview = build_preview(path, analysis, "privilege_log", mapping)
    assert preview.headers == ["Bates Range", "People"]
    assert preview.total_rows == analysis.row_count
    assert preview.rows[0][0] == "SYNREFLCPRV001-0000001"


def test_rfp_output_is_grouped_plain_text(tmp_path: Path) -> None:
    source = tmp_path / "pleading.csv"
    source.write_text(
        "Bates/Control #,End Bates/Control #,RFP\n"
        "CPSD_KBW_000001,CPSD_KBW_001292,RFP 01\n"
        "CPSD_KBW_001295,CPSD_KBW_001296,RFP 01\n"
        "CPSD_KBW_001300,CPSD_KBW_001484,RFP 01\n"
        "CPSD_KBW_001500,CPSD_KBW_001501,RFP 02\n",
        encoding="utf-8",
    )
    analysis = analyze_csv(source, source.name)
    output = tmp_path / "ranges.txt"
    stats = write_output(output, source, analysis, "rfp_ranges", None, 0)

    assert output.read_bytes() == (
        b"RFP 01\r\nCPSD_KBW_000001-1292, CPSD_KBW_001295-1296, and CPSD_KBW_001300-1484\r\n\r\n"
        b"RFP 02\r\nCPSD_KBW_001500-1501\r\n"
    )
    assert stats.output_rows == 4
    assert stats.formula_escapes == 0


@pytest.mark.parametrize(
    ("settings", "expected"),
    [
        (PleadingSettings(), "TEST_0001, TEST_0002, and TEST_0003"),
        (PleadingSettings(delimiter="semicolon"), "TEST_0001; TEST_0002; and TEST_0003"),
        (PleadingSettings(delimiter="pipe"), "TEST_0001 | TEST_0002 | and TEST_0003"),
        (PleadingSettings(delimiter="newline"), "TEST_0001\r\nTEST_0002\r\nand TEST_0003"),
        (PleadingSettings(delimiter="comma", include_and=False), "TEST_0001, TEST_0002, TEST_0003"),
        (PleadingSettings(delimiter="semicolon", include_and=False), "TEST_0001; TEST_0002; TEST_0003"),
        (PleadingSettings(delimiter="pipe", include_and=False), "TEST_0001 | TEST_0002 | TEST_0003"),
        (PleadingSettings(delimiter="newline", include_and=False), "TEST_0001\r\nTEST_0002\r\nTEST_0003"),
    ],
)
def test_rfp_text_delimiter_and_conjunction_settings(settings: PleadingSettings, expected: str) -> None:
    rows = [
        ["RFP 01", "TEST_0001", "TEST_0001"],
        ["RFP 01", "TEST_0002", "TEST_0002"],
        ["RFP 01", "TEST_0003", "TEST_0003"],
    ]
    assert render_rfp_text(rows, settings) == f"RFP 01\r\n{expected}\r\n"


def test_rfp_text_handles_empty_single_two_and_multiple_groups() -> None:
    assert render_rfp_text([]) == ""
    assert render_rfp_text([["RFP 01", "TEST_0001", "TEST_0001"]]) == "RFP 01\r\nTEST_0001\r\n"
    assert (
        render_rfp_text([["RFP 01", "TEST_0001", "TEST_0001"], ["RFP 01", "TEST_0002", "TEST_0002"]])
        == "RFP 01\r\nTEST_0001 and TEST_0002\r\n"
    )
    assert (
        render_rfp_text(
            [
                ["RFP 01", "TEST_0001", "TEST_0001"],
                ["RFP 01", "TEST_0002", "TEST_0002"],
                ["RFP 02", "TEST_0003", "TEST_0003"],
                ["RFP 02", "TEST_0004", "TEST_0004"],
            ]
        )
        == "RFP 01\r\nTEST_0001 and TEST_0002\r\n\r\nRFP 02\r\nTEST_0003 and TEST_0004\r\n"
    )


def test_privilege_fill_uses_first_nonblank_source(tmp_path: Path) -> None:
    source = tmp_path / "privilege.csv"
    source.write_text(
        "Primary,Secondary,Tertiary\nFirst,Second,Third\n,Fallback,Third\n  ,,Last\n,,\n",
        encoding="utf-8",
    )
    analysis = analyze_csv(source, source.name)
    mapping = MappingConfig.model_validate(
        {
            "columns": [
                {
                    "id": "filled",
                    "name": "Best value",
                    "source_fields": ["Primary", "Secondary", "Tertiary"],
                    "transform": {"kind": "fill"},
                }
            ]
        }
    )

    preview = build_preview(source, analysis, "privilege_log", mapping)
    assert [row[0] for row in preview.rows] == ["First", "Fallback", "Last", ""]


def test_contact_normalization_preserves_email_case_and_name_apostrophes() -> None:
    assert normalize_contact_value("FIRST LAST 'Example@Gmail.com'") == "First Last Example@Gmail.com"
    assert normalize_contact_value("FIRST LAST <Example@Hotmail.com>") == "First Last Example@Hotmail.com"
    assert normalize_contact_value("O'CONNOR") == "O'Connor"
    assert normalize_contact_value("FIRST LAST <a@gmail.com>; SECOND PERSON 'B@HOTMAIL.COM'") == (
        "First Last a@gmail.com; Second Person B@HOTMAIL.COM"
    )


def test_mapping_normalize_defaults_off_and_applies_after_every_transform(tmp_path: Path) -> None:
    source = tmp_path / "contacts.csv"
    source.write_text(
        "Begin,End,Primary,Secondary,Third\n"
        "TEST_0001,TEST_0002,FIRST LAST 'A@GMAIL.COM',SECOND PERSON <B@HOTMAIL.COM>,\n"
        "TEST_0003,TEST_0003,,FALLBACK PERSON <C@OUTLOOK.COM>,THIRD PERSON\n",
        encoding="utf-8",
    )
    direct = MappingConfig.model_validate(
        {"columns": [{"id": "direct", "name": "Direct", "source_fields": ["Primary"], "transform": {"kind": "none"}}]}
    )
    assert direct.columns[0].normalize is False
    assert list(iter_privilege_output_rows(source, direct))[0][0] == "FIRST LAST 'A@GMAIL.COM'"

    cases = [
        ({"kind": "none"}, ["Primary"], "First Last A@GMAIL.COM"),
        ({"kind": "shorten_bates"}, ["Begin", "End"], "Test_0001-2"),
        ({"kind": "fill"}, ["Primary", "Secondary", "Third"], "First Last A@GMAIL.COM"),
        (
            {"kind": "delimit", "delimiter": "; "},
            ["Primary", "Secondary"],
            "First Last A@GMAIL.COM; Second Person B@HOTMAIL.COM",
        ),
        (
            {"kind": "delimit", "delimiter": ", "},
            ["Primary", "Secondary"],
            "First Last A@GMAIL.COM, Second Person B@HOTMAIL.COM",
        ),
        (
            {"kind": "delimit", "delimiter": " | "},
            ["Primary", "Secondary"],
            "First Last A@GMAIL.COM | Second Person B@HOTMAIL.COM",
        ),
        (
            {"kind": "delimit", "delimiter": "\n"},
            ["Primary", "Secondary"],
            "First Last A@GMAIL.COM\nSecond Person B@HOTMAIL.COM",
        ),
    ]
    for index, (transform, fields, expected) in enumerate(cases):
        mapping = MappingConfig.model_validate(
            {
                "columns": [
                    {
                        "id": f"normalized-{index}",
                        "name": "Normalized",
                        "source_fields": fields,
                        "transform": transform,
                        "normalize": True,
                    }
                ]
            }
        )
        assert list(iter_privilege_output_rows(source, mapping))[0][0] == expected


def test_personal_data_detection_is_header_aware_and_advisory(tmp_path: Path) -> None:
    source = tmp_path / "personal-data.csv"
    source.write_text(
        "Bates/Control #,End Bates/Control #,Date Sent,Employee DOB Value,Employee Social Security #,Author,Subject\n"
        "TEST_123456789,TEST_123456789,01/02/1990,01/02/1990,000123456,jsmith,solo\n"
        "TEST_000000002,TEST_000000002,1991-03-04,1991-03-04,000-12-3456,"
        "FIRST LAST <person@gmail.com>,person@business.example\n",
        encoding="utf-8",
    )
    analysis = analyze_csv(source, source.name)
    findings = {finding.category: finding for finding in analysis.personal_data_findings}
    assert findings["ssn"].count == 2
    assert findings["date_of_birth"].count == 2
    assert findings["personal_email"].count == 1
    assert findings["single_word_name"].count == 1
    assert findings["date_of_birth"].columns == ["Employee DOB Value"]
    assert findings["single_word_name"].columns == ["Author"]
    assert not analysis.issues


@pytest.mark.parametrize(
    "columns",
    [
        [
            {"id": "a", "name": "Duplicate", "source_fields": ["A"], "transform": {"kind": "none"}},
            {"id": "b", "name": "duplicate", "source_fields": ["B"], "transform": {"kind": "none"}},
        ],
        [{"id": "a", "name": "Missing", "source_fields": [], "transform": {"kind": "none"}}],
        [{"id": "a", "name": "Direct", "source_fields": ["A", "B"], "transform": {"kind": "none"}}],
        [{"id": "a", "name": "Range", "source_fields": ["A"], "transform": {"kind": "shorten_bates"}}],
        [{"id": "a", "name": "Joined", "source_fields": ["A", "B"], "transform": {"kind": "delimit"}}],
    ],
)
def test_mapping_constraints_reject_invalid_configurations(columns: list[dict]) -> None:
    with pytest.raises(ValueError):
        MappingConfig.model_validate({"columns": columns})


def test_mapping_allows_a_source_field_in_multiple_output_columns() -> None:
    mapping = MappingConfig.model_validate(
        {
            "columns": [
                {"id": "a", "name": "First", "source_fields": ["A"], "transform": {"kind": "none"}},
                {"id": "b", "name": "Second", "source_fields": ["A"], "transform": {"kind": "none"}},
            ]
        }
    )
    assert [column.source_fields for column in mapping.columns] == [["A"], ["A"]]


def test_mapping_server_bounds_reject_amplification() -> None:
    with pytest.raises(ValueError):
        MappingConfig.model_validate(
            {
                "columns": [
                    {
                        "id": f"c{index}",
                        "name": f"Column {index}",
                        "source_fields": ["A"],
                        "transform": {"kind": "none"},
                    }
                    for index in range(101)
                ]
            }
        )
    with pytest.raises(ValueError):
        MappingConfig.model_validate(
            {"columns": [{"id": "x" * 121, "name": "A", "source_fields": ["A"], "transform": {"kind": "none"}}]}
        )


def test_rfp_analysis_keeps_prefixes_separate_for_duplicates_and_gaps(tmp_path: Path) -> None:
    source = tmp_path / "prefixes.csv"
    source.write_text(
        "Bates/Control #,End Bates/Control #,RFP\n"
        "A0001,A0010,RFP 01\n"
        "B0001,B0010,RFP 01\n"
        "A0002,A0003,RFP 01\n"
        "A0011,A0012,RFP 01\n",
        encoding="utf-8",
    )
    analysis = analyze_csv(source, source.name)
    assert analysis.duplicate_ranges == 0
    assert analysis.gap_count == 0


def test_privilege_headers_are_formula_escaped(tmp_path: Path) -> None:
    source = tmp_path / "header.csv"
    source.write_text("A\nvalue\n", encoding="utf-8")
    analysis = analyze_csv(source, source.name)
    mapping = MappingConfig.model_validate(
        {
            "columns": [
                {"id": "a", "name": "=DANGEROUS", "source_fields": ["A"], "transform": {"kind": "none"}},
            ]
        }
    )
    output = tmp_path / "output.csv"
    write_output(output, source, analysis, "privilege_log", mapping, 0)
    assert output.read_text(encoding="utf-8-sig").startswith("'=DANGEROUS\n")


def test_recoverable_issue_has_warning_metadata(tmp_path: Path) -> None:
    source = tmp_path / "warning.csv"
    source.write_text(
        "Bates/Control #,End Bates/Control #,RFP\nGOOD_0001,GOOD_0002,RFP 01\n,GOOD_0003,RFP 02\n,GOOD_0004,RFP 03\n",
        encoding="utf-8",
    )

    analysis = analyze_csv(source, source.name)
    issue = next(item for item in analysis.issues if item.code == "blank_begin_bates")
    assert issue.severity == "warning"
    assert issue.overrideable is True
    assert issue.row == 3
    assert issue.column == "Bates/Control #"
    assert issue.count == 2


def test_header_only_file_is_blocking(tmp_path: Path) -> None:
    source = tmp_path / "header-only.csv"
    source.write_text("Bates/Control #,End Bates/Control #,RFP\n", encoding="utf-8")
    analysis = analyze_csv(source, source.name)
    issue = next(item for item in analysis.issues if item.code == "no_data_rows")
    assert issue.severity == "error"
    assert issue.overrideable is False


@pytest.mark.parametrize(
    "value", ["=SUM(A1:A2)", " \t+cmd", "\r@formula", "＝SUM(A1:A2)", " ＋cmd", "－1", "＠formula"]
)
def test_formula_escape_handles_whitespace_controls_and_full_width_initiators(value: str) -> None:
    escaped, changed = escape_formula(value)
    assert changed is True
    assert escaped == f"'{value}"


def test_duplicate_and_blank_headers_are_blocking_without_exposing_values(tmp_path: Path) -> None:
    source = tmp_path / "ambiguous.csv"
    source.write_text("Author, author ,\nFirst,Second,Secret\n", encoding="utf-8")

    analysis = analyze_csv(source, source.name)

    issues = {issue.code: issue for issue in analysis.issues}
    assert issues["duplicate_header"].severity == "error"
    assert issues["duplicate_header"].column == "columns 1, 2"
    assert issues["blank_header"].column == "column 3"
    assert "Secret" not in " ".join(issue.message for issue in analysis.issues)


def test_extreme_bates_suffix_is_a_controlled_issue(tmp_path: Path) -> None:
    source = tmp_path / "oversized-bates.csv"
    source.write_text(
        f"Bates/Control #,End Bates/Control #,RFP\nTEST_{'9' * 5000},TEST_{'9' * 5000},RFP 01\n",
        encoding="utf-8",
    )

    analysis = analyze_csv(source, source.name)

    issue = next(item for item in analysis.issues if item.code == "numeric_overflow")
    assert issue.row == 2
    assert issue.severity == "warning"


def test_privilege_output_reconciles_skips_and_header_formula_escapes(tmp_path: Path) -> None:
    source = tmp_path / "uneven.csv"
    source.write_text("A,B\nfirst,second\nuneven\n", encoding="utf-8")
    analysis = analyze_csv(source, source.name)
    mapping = MappingConfig.model_validate(
        {"columns": [{"id": "a", "name": "=Header", "source_fields": ["A"], "transform": {"kind": "none"}}]}
    )
    output = tmp_path / "output.csv"

    stats = write_output(output, source, analysis, "privilege_log", mapping, 0)
    preview = build_preview(source, analysis, "privilege_log", mapping)

    assert stats.input_rows == stats.output_rows + stats.skipped_rows == 2
    assert stats.formula_escapes == 1
    assert preview.headers == ["'=Header"]
    assert preview.skipped_rows == 1
    assert preview.formula_escapes == 1


def test_rog_tags_and_multiple_combined_requests_reach_output(tmp_path: Path) -> None:
    separate = tmp_path / "separate.csv"
    separate.write_text(
        "Begin Bates,End Bates,Tag: RFP 01,Tag: ROG 02\n"
        "ABC0001,ABC0002,TRUE,TRUE\nABC0003,ABC0003,,TRUE\n", encoding="utf-8"
    )
    analysis = analyze_csv(separate, separate.name)
    _, rows, skipped = rfp_output_rows(separate, analysis)
    assert analysis.request_count == 2
    assert [(row[0], row[1], row[2]) for row in rows] == [
        ("RFP 01", "ABC0001", "ABC0002"), ("ROG 02", "ABC0001", "ABC0003")
    ]
    assert skipped == 0

    combined = tmp_path / "combined.csv"
    combined.write_text(
        'Begin Bates,End Bates,RFP\nABC0001,ABC0002,"RFP 01; RFP 03, ROG 02; free text"\n',
        encoding="utf-8",
    )
    analysis = analyze_csv(combined, combined.name)
    _, rows, _ = rfp_output_rows(combined, analysis)
    assert analysis.request_count == 3
    assert {row[0] for row in rows} == {"RFP 01", "RFP 03", "ROG 02; free text"}


def test_rfp_receipt_counts_excluded_uneven_rows(tmp_path: Path) -> None:
    source = tmp_path / "uneven-rfp.csv"
    source.write_text(
        "Begin Bates,End Bates,Tag: RFP 01\nABC0001,ABC0002,TRUE\nABC0005,ABC0006,TRUE,\n",
        encoding="utf-8",
    )
    analysis = analyze_csv(source, source.name)
    warning = next(issue for issue in analysis.issues if issue.code == "uneven_row_width")
    assert "excluded" in warning.message
    preview = build_preview(source, analysis, "rfp_ranges", None)
    stats = write_output(tmp_path / "output.txt", source, analysis, "rfp_ranges", None, 1)
    assert preview.skipped_rows == stats.skipped_rows == 1
    assert stats.input_rows == 2


def test_large_valid_cell_cp1252_and_prefixless_bates(tmp_path: Path) -> None:
    source = tmp_path / "excel.csv"
    source.write_bytes(
        ("Begin Bates,End Bates,Tag: RFP 01,Subject\n"
         '000001,000002,TRUE,"Client’s memo ' + "x" * 140_000 + '"\n').encode("cp1252")
    )
    analysis = analyze_csv(source, source.name)
    assert not analysis.issues
    _, rows, skipped = rfp_output_rows(source, analysis)
    assert rows[0][0] == "RFP 01"
    assert rows[0][1] == "000001"
    assert skipped == 0
    assert shorten_bates("000001", "000002") == "000001-2"


def test_oversized_cell_has_specific_issue(tmp_path: Path) -> None:
    source = tmp_path / "oversized-field.csv"
    source.write_text(
        "Begin Bates,End Bates,Tag: RFP 01,Notes\nABC0001,ABC0002,TRUE,\""
        + "x" * (16 * 1024 * 1024 + 1) + "\"\n", encoding="utf-8"
    )
    codes = {issue.code for issue in analyze_csv(source, source.name).issues}
    assert "field_too_large" in codes
    assert "broken_quote" not in codes


def test_personal_data_email_scan_is_bounded_on_hostile_cell() -> None:
    started = time.perf_counter()
    assert personal_data_matches("Email To", "a!" * 65_536) == {}
    assert time.perf_counter() - started < 2


def test_preview_discloses_display_truncation(tmp_path: Path) -> None:
    source = tmp_path / "long.csv"
    source.write_text(f"A\n{'x' * 501}\n", encoding="utf-8")
    analysis = analyze_csv(source, source.name)
    mapping = MappingConfig.model_validate(
        {"columns": [{"id": "a", "name": "A", "source_fields": ["A"], "transform": {"kind": "none"}}]}
    )

    preview = build_preview(source, analysis, "privilege_log", mapping)

    assert preview.sample_truncated is True
    assert len(preview.rows[0][0]) == 500


def test_artifact_preview_reads_exact_staged_csv_bytes(tmp_path: Path) -> None:
    source = tmp_path / "source.csv"
    source.write_text("A\n=formula\n", encoding="utf-8")
    analysis = analyze_csv(source, source.name)
    mapping = MappingConfig.model_validate(
        {"columns": [{"id": "a", "name": "=Header", "source_fields": ["A"], "transform": {"kind": "none"}}]}
    )
    staged = tmp_path / "staged.csv"
    stats = write_output(staged, source, analysis, "privilege_log", mapping, 0)

    preview = build_artifact_preview(
        staged,
        "privilege_log",
        stats,
        artifact_sha256="a" * 64,
        configuration_revision=3,
        review_token="b" * 64,
    )

    assert preview.headers == ["'=Header"]
    assert preview.rows == [["'=formula"]]
    assert preview.formula_escapes == 2
    assert preview.configuration_revision == 3
