"""Synthetic matter code layouts and configuration-specific request extraction."""

import csv

import pytest
from pydantic import ValidationError

from app.models import PleadingSettings, RequestSource
from app.processor import analyze_csv, build_preview, write_output
from app.request_sources import (
    RequestConfigurationError,
    RequestExtractor,
    candidates,
    legacy_cell_labels,
    observe_candidate,
)


def source_csv(tmp_path, headers, rows):
    path = tmp_path / "synthetic.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Bates/Control #", "End Bates/Control #", *headers])
        writer.writerows(rows)
    return path


def configured(*sources):
    return PleadingSettings(request_sources=[RequestSource(**s) for s in sources])


@pytest.mark.parametrize("value", ["TRUE", " yes ", "1", "X", "Code: description", "Matter: Code: description"])
def test_individual_assignment_values(value):
    settings = configured({"column": "Matter: Code: description"})
    extractor = RequestExtractor(["Matter: Code: description"], settings)
    assert [(a.category, a.code) for a in extractor.extract({"Matter: Code: description": value})] == [
        ("Matter", "Code: description")
    ]
    extractor.require_acknowledgments()


@pytest.mark.parametrize("value", ["", " NULL ", "false", "NO", "0"])
def test_unassigned_individual_cells(value):
    extractor = RequestExtractor(["Disclosure: Emails"], configured({"column": "Disclosure: Emails"}))
    assert extractor.extract({"Disclosure: Emails": value}) == []
    extractor.require_acknowledgments()


def test_unexpected_values_require_acknowledgment_and_count_first_row():
    extractor = RequestExtractor(["Disclosure: Emails"], configured({"column": "Disclosure: Emails"}))
    for row in (3, 9):
        assert extractor.extract({"Disclosure: Emails": "another code"}, row) == []
    with pytest.raises(RequestConfigurationError) as caught:
        extractor.require_acknowledgments()
    assert caught.value.issues[0].count == 2
    assert caught.value.issues[0].row == 3
    extractor.require_acknowledgments(["unexpected_request_value"])


@pytest.mark.parametrize("separator", ["; ", ", ", " | ", "\n", "\r\n", "\x13"])
def test_automatic_category_boundaries_preserve_punctuation(separator):
    extractor = RequestExtractor(["Disclosure"], configured({"column": "Disclosure", "layout": "category"}))
    value = "Disclosure: Emails, calendars: 2026" + separator + "Disclosure: Notes (2)"
    assert [a.code for a in extractor.extract({"Disclosure": value})] == [
        "Emails, calendars: 2026", "Notes (2)",
    ]
    extractor.require_acknowledgments()


@pytest.mark.parametrize(("separator", "value"), [
    ("semicolon", "Alpha; Beta"), ("comma", "Alpha, Beta"), ("pipe", "Alpha|Beta"),
    ("newline", "Alpha\r\nBeta"),
])
def test_explicit_input_separator(separator, value):
    extractor = RequestExtractor(["Matter"], configured({
        "column": "Matter", "layout": "category", "input_separator": separator,
    }))
    assert [a.code for a in extractor.extract({"Matter": value})] == ["Alpha", "Beta"]


def test_ambiguous_input_requires_layout_decision():
    extractor = RequestExtractor(["Matter"], configured({"column": "Matter", "layout": "category"}))
    assert extractor.extract({"Matter": "Emails, calendars"}, 2) == []
    with pytest.raises(RequestConfigurationError) as caught:
        extractor.require_acknowledgments(["ambiguous_request_separator"])
    assert caught.value.issues[0].severity == "error"
    assert extractor.extract({"Matter": "Matter: Emails; Notes"}, 3) == []
    single = RequestExtractor(["Matter"], configured({
        "column": "Matter", "layout": "category", "input_separator": "single",
    }))
    assert single.extract({"Matter": "Emails, calendars"})[0].code == "Emails, calendars"
    assert single.extract({"Matter": "Matter: Alpha; details"})[0].code == "Alpha; details"
    assert single.extract({"Matter": "Matter:"}) == []


def test_candidates_observe_custom_categories_without_suggesting_privilege():
    found = candidates(["Custom matter", "RFPs: RFP 23 (2): Unicode café", "Privilege: Withheld"])
    observe_candidate(found[0], "null")
    observe_candidate(found[0], "Custom matter: No number")
    observe_candidate(found[0], "Custom matter: No number")
    for value in ["Second", "Third", "Fourth"]:
        observe_candidate(found[0], value)
    assert found[0].layout == "category"
    assert len(found[0].samples) == 3
    assert not found[0].suggested and not found[2].suggested
    assert found[1].code == "RFP 23 (2): Unicode café" and found[1].suggested
    assert legacy_cell_labels("null; RFP 2") == ["RFP 02"]


def test_full_labels_two_layouts_collisions_sorting_and_invalid_ranges(tmp_path):
    headers = ["Matter: RFP 23 (2): Café, calendars", "Matter: RFP 23: First",
               "Matter: Alpha", "Matter", "Other: Alpha"]
    source = source_csv(tmp_path, headers, [
        ["SYN_0001", "SYN_0002", "RFP 23 (2): Café, calendars", "TRUE", "Alpha", "Matter: Alpha", "Alpha"],
        ["SYN_0003", "SYN_0004", "null", "TRUE", "TRUE", "null", "null"],
        ["SYN_0009", "SYN_0008", "TRUE", "TRUE", "TRUE", "null", "null"],
    ])
    analysis = analyze_csv(source, source.name)
    assert analysis.detected_workflow == "rfp_ranges"
    assert analysis.platform == "unknown"
    settings = configured(*[{"column": h, "layout": "category" if h == "Matter" else "individual"} for h in headers])
    preview = build_preview(source, analysis, "rfp_ranges", None, pleading_settings=settings)
    assert preview.rows == [
        ["RFP 23 (2): Café, calendars", "SYN_0001-2"], ["RFP 23: First", "SYN_0001-4"],
        ["Matter: Alpha", "SYN_0001-4"], ["Other: Alpha", "SYN_0001-2"],
    ]
    output = tmp_path / "output.txt"
    stats = write_output(output, source, analysis, "rfp_ranges", None, 1, settings)
    assert output.read_bytes().decode() == preview.text
    assert stats.skipped_rows == 1
    assert stats.output_rows == 4


def test_arbitrary_names_are_available_without_privilege_classification(tmp_path):
    source = source_csv(tmp_path, ["Evidence: Calendars"], [["SYN_0001", "SYN_0001", "Calendars"]])
    analysis = analyze_csv(source, source.name)
    assert analysis.detected_workflow == "unknown" and analysis.request_count == 0
    settings = configured({"column": "Evidence: Calendars"})
    assert build_preview(source, analysis, "rfp_ranges", None, pleading_settings=settings).rows == [
        ["Calendars", "SYN_0001"]
    ]
    extractor = RequestExtractor(["Calendars"], configured({"column": "Calendars"}))
    assert extractor.extract({"Calendars": "Calendars"})[0].category == ""


def test_spool_warnings_and_empty_output_are_actionable(tmp_path):
    source = source_csv(tmp_path, ["Matter: Notes"], [
        ["SYN_0001", "SYN_0002", "Notes"], ["SYN_0003", "SYN_0004", "Wrong code"],
    ])
    analysis = analyze_csv(source, source.name)
    settings = configured({"column": "Matter: Notes"})
    with pytest.raises(RequestConfigurationError):
        build_preview(source, analysis, "rfp_ranges", None, pleading_settings=settings)
    output = tmp_path / "output.txt"
    write_output(output, source, analysis, "rfp_ranges", None, 1, settings,
                 acknowledged_issue_codes=["unexpected_request_value"])
    assert "SYN_0001-2" in output.read_text() and "SYN_0003" not in output.read_text()
    with pytest.raises(RequestConfigurationError, match="no recoverable"):
        write_output(output, source, analysis, "rfp_ranges", None, 0, configured())
    assert not output.exists()
    with pytest.raises(ValidationError, match="only once"):
        configured({"column": "Matter: Notes"}, {"column": "Matter: Notes"})


def test_case_distinct_codes_and_legacy_counts_do_not_collapse(tmp_path):
    source = source_csv(tmp_path, ["RFP"], [
        ["SYN_0001", "SYN_0001", "Custom"], ["SYN_0002", "SYN_0002", "CUSTOM"],
    ])
    analysis = analyze_csv(source, source.name)
    assert analysis.request_count == 2
    assert len(build_preview(source, analysis, "rfp_ranges", None).rows) == 2
    settings = configured({"column": "Matter: Notes"}, {"column": "Matter: NOTES"}, {"column": "Tag:"})
    extractor = RequestExtractor([s.column for s in settings.request_sources], settings)
    result = extractor.extract({"Matter: Notes": "TRUE", "Matter: NOTES": "TRUE", "Tag:": "TRUE"})
    assert [a.code for a in result] == ["Notes", "NOTES"]
    with pytest.raises(RequestConfigurationError):
        extractor.require_acknowledgments()


def test_source_order_precedes_first_seen_row_and_cross_layout_duplicates(tmp_path):
    headers = ["Matter: Later", "Matter: Other", "Matter"]
    source = source_csv(tmp_path, headers, [
        ["SYN_0001", "SYN_0002", "null", "TRUE", "Matter: Later"],
        ["SYN_0003", "SYN_0004", "TRUE", "null", "null"],
    ])
    settings = configured(*[{"column": h, "layout": "category" if h == "Matter" else "individual"}
                            for h in reversed(headers)])
    preview = build_preview(source, analyze_csv(source, source.name), "rfp_ranges", None, pleading_settings=settings)
    assert preview.rows == [["Later", "SYN_0001-4"], ["Other", "SYN_0001-2"]]


@pytest.mark.parametrize("header", ["RFP 01", "ROG 02: Notes", "RFP1", "ROG2", "Matter: RFP1"])
def test_standalone_numbered_boolean_columns_are_not_category_lists(tmp_path, header):
    source = source_csv(tmp_path, [header], [["SYN_0001", "SYN_0002", "TRUE"]])
    analysis = analyze_csv(source, source.name)
    assert analysis.request_candidates[0].layout == "individual"
    assert analysis.request_count == 1
    preview = build_preview(source, analysis, "rfp_ranges", None)
    assert preview.rows[0][0] != "TRUE"


@pytest.mark.parametrize("combined_label", ["FALSE", "No", "0"])
def test_legacy_combined_nonempty_labels_take_precedence_over_flags(combined_label):
    extractor = RequestExtractor(["RFP", "RFP1"])
    assert [a.code for a in extractor.extract({"RFP": combined_label, "RFP1": "TRUE"})] == [combined_label]
    assert [a.code for a in extractor.extract({"RFP": "null", "RFP1": "TRUE"})] == ["RFP 01"]


def test_inferred_matter_category_agrees_between_analysis_and_default_output(tmp_path):
    source = source_csv(tmp_path, ["Matter RFP codes"], [
        ["SYN_0001", "SYN_0002", "Matter RFP codes: First | Matter RFP codes: Second"],
    ])
    analysis = analyze_csv(source, source.name)
    assert analysis.request_candidates[0].layout == "category"
    assert analysis.request_count == 2
    assert build_preview(source, analysis, "rfp_ranges", None).rows == [
        ["First", "SYN_0001-2"], ["Second", "SYN_0001-2"],
    ]


def test_extremely_long_request_numbers_are_preserved_without_integer_conversion(tmp_path):
    label = "RFP " + "9" * 5000
    source = source_csv(tmp_path, ["RFP"], [["SYN_0001", "SYN_0002", label]])
    analysis = analyze_csv(source, source.name)
    output = tmp_path / "long-number.txt"
    write_output(output, source, analysis, "rfp_ranges", None, 0)
    assert output.read_text().startswith(label + "\nSYN_0001-2")
    assert legacy_cell_labels(label) == [label]
    from app.request_sources import legacy_header_label
    assert legacy_header_label(label) is None


def test_category_qualification_cannot_merge_distinct_request_identities(tmp_path):
    headers = ["A: Shared", "B: Shared", "Other: A: Shared"]
    source = source_csv(tmp_path, headers, [["SYN_0001", "SYN_0002", "TRUE", "TRUE", "TRUE"]])
    settings = configured(*[{"column": h} for h in headers])
    preview = build_preview(source, analyze_csv(source, source.name), "rfp_ranges", None, pleading_settings=settings)
    assert len(preview.rows) == 3
    assert len({r[0] for r in preview.rows}) == 3
    assert preview.rows[0][0] == "A: Shared"


def test_unexpected_value_reports_original_record_after_excluded_row(tmp_path):
    source = source_csv(tmp_path, ["Matter: Notes"], [
        ["SYN_0001", "SYN_0002", "Notes", "extra"], ["SYN_0003", "SYN_0004", "Wrong"],
    ])
    settings = configured({"column": "Matter: Notes"})
    with pytest.raises(RequestConfigurationError) as caught:
        build_preview(source, analyze_csv(source, source.name), "rfp_ranges", None, pleading_settings=settings)
    assert caught.value.issues[0].row == 3


def test_catalog_capacity_failure_closes_scratch_connection(tmp_path):
    source = source_csv(tmp_path, ["Matter: Notes"], [["SYN_0001", "SYN_0002", "Notes"]])
    settings = configured({"column": "Matter: Notes"})
    from app.processor import ProcessingLimitError
    with pytest.raises(ProcessingLimitError, match="scratch-space"):
        write_output(tmp_path / "output.txt", source, analyze_csv(source, source.name), "rfp_ranges", None, 0,
                     settings, max_work_bytes=4096)
    assert not list((tmp_path / "scratch").iterdir())
