# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Streaming CSV analysis and RFP or privilege-log output transformations."""

from __future__ import annotations

import codecs
import csv
import re
import sqlite3
import tempfile
import time
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import datetime
from itertools import islice
from pathlib import Path

from .models import (
    Analysis,
    DetectedWorkflow,
    Issue,
    IssueSeverity,
    MappingConfig,
    OutputStats,
    PersonalDataCategory,
    PersonalDataFinding,
    Platform,
    PleadingSettings,
    Preview,
)

BEGIN_ALIASES = ("bates/control #", "begin bates")
END_ALIASES = ("end bates/control #", "end bates")
FORMULA_PREFIXES = ("=", "+", "-", "@", "＝", "＋", "－", "＠")
BATES_PATTERN = re.compile(r"^(.*?)(\d+)$")
RFP_NUMBER_PATTERN = re.compile(r"^(?:tag:\s*)?rfp(?:\s*:\s*rfp)?\s*(\d+)\b", re.IGNORECASE)


class ProcessingLimitError(RuntimeError):
    """Raised when bounded processing scratch space is exhausted."""


EMAIL_PATTERN = re.compile(
    r"(?<![\w.+-])([A-Z0-9.!#$%&*+/=?^_`{|}~-]+@([A-Z0-9.-]+\.[A-Z]{2,63}))(?![\w.-])",
    re.IGNORECASE,
)
FORMATTED_SSN_PATTERN = re.compile(r"(?<!\d)\d{3}[- ]\d{2}[- ]\d{4}(?!\d)")
COMPACT_SSN_PATTERN = re.compile(r"(?<!\d)\d{9}(?!\d)")
SINGLE_WORD_NAME_PATTERN = re.compile(r"^[^\W\d_][\w.-]{1,63}$", re.UNICODE)
DOB_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%m-%d-%Y",
    "%m/%d/%y",
    "%m-%d-%y",
    "%B %d, %Y",
    "%b %d, %Y",
    "%d %B %Y",
    "%d %b %Y",
)
DOB_HEADERS = frozenset({"dob", "date of birth", "birth date", "birthdate", "birthday"})
SSN_HEADERS = frozenset({"ssn", "social security", "social security number", "social security no"})
PEOPLE_HEADER_TERMS = frozenset({"author", "from", "to", "cc", "bcc", "sender", "recipient", "custodian", "name"})
PERSONAL_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "hotmail.com",
        "hotmail.co.uk",
        "live.com",
        "live.co.uk",
        "outlook.com",
        "outlook.co.uk",
        "msn.com",
        "yahoo.com",
        "yahoo.co.uk",
        "aol.com",
        "icloud.com",
        "me.com",
        "mac.com",
        "protonmail.com",
        "proton.me",
        "gmx.com",
        "gmx.net",
        "mail.com",
        "yandex.com",
        "yandex.ru",
        "comcast.net",
        "att.net",
        "verizon.net",
        "ymail.com",
        "rocketmail.com",
        "fastmail.com",
        "hey.com",
        "hushmail.com",
        "zoho.com",
        "mail.ru",
        "inbox.com",
        "passport.com",
        "sbcglobal.net",
        "bellsouth.net",
        "cox.net",
    }
)
LOGIKCULL_METADATA_HEADERS = frozenset(
    {
        "author",
        "bcc",
        "cc",
        "date received",
        "date sent",
        "filename",
        "from",
        "privilege",
        "privilege reason",
        "redactions",
        "subject",
        "title",
        "to",
    }
)
EVERLAW_METADATA_HEADERS = frozenset(
    {
        "date",
        "email bcc",
        "email cc",
        "email from",
        "email subject",
        "email to",
        "file name",
    }
)


@dataclass(frozen=True)
class Bates:
    raw: str
    prefix: str
    number_text: str
    number: int


@dataclass(frozen=True)
class PersonalDataProfile:
    header: str
    dob: bool
    ssn: bool
    people: bool


def normalize_header(value: str) -> str:
    return " ".join(value.strip().casefold().split())


def semantic_header(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", normalize_header(value)))


def is_people_header(value: str) -> bool:
    normalized = semantic_header(value)
    if normalized in PEOPLE_HEADER_TERMS:
        return True
    tokens = set(normalized.split())
    return (
        "file" not in tokens
        and "filename" not in tokens
        and bool(tokens & PEOPLE_HEADER_TERMS)
        and bool(tokens & {"email", "contact", "person", "party", "name"})
    )


def is_date_of_birth(value: str) -> bool:
    candidate = value.strip()
    if not candidate:
        return False
    for date_format in DOB_FORMATS:
        try:
            datetime.strptime(candidate, date_format)
            return True
        except ValueError:
            continue
    return False


def is_dob_header(value: str) -> bool:
    normalized = semantic_header(value)
    tokens = set(normalized.split())
    return normalized in DOB_HEADERS or "dob" in tokens or {"birth", "date"} <= tokens


def is_ssn_header(value: str) -> bool:
    normalized = semantic_header(value)
    tokens = set(normalized.split())
    return normalized in SSN_HEADERS or "ssn" in tokens or {"social", "security"} <= tokens


def is_personal_email_domain(value: str) -> bool:
    domain = value.casefold()
    if domain in PERSONAL_EMAIL_DOMAINS:
        return True
    return any(
        domain.startswith(f"{provider}.") for provider in ("hotmail", "live", "outlook", "yahoo", "gmx", "yandex")
    )


def personal_data_profile(header: str) -> PersonalDataProfile:
    return PersonalDataProfile(
        header=header,
        dob=is_dob_header(header),
        ssn=is_ssn_header(header),
        people=is_people_header(header),
    )


def _personal_data_matches(profile: PersonalDataProfile, value: str) -> dict[str, int]:
    matches: dict[str, int] = {}
    ssn_count = len(FORMATTED_SSN_PATTERN.findall(value))
    if profile.ssn:
        ssn_count += len(COMPACT_SSN_PATTERN.findall(value))
    if ssn_count:
        matches["ssn"] = ssn_count
    if profile.dob and is_date_of_birth(value):
        matches["date_of_birth"] = 1
    personal_email_count = sum(1 for match in EMAIL_PATTERN.finditer(value) if is_personal_email_domain(match.group(2)))
    if personal_email_count:
        matches["personal_email"] = personal_email_count
    candidate = value.strip().strip("<>'").strip()
    if profile.people and "@" not in candidate and SINGLE_WORD_NAME_PATTERN.fullmatch(candidate):
        matches["single_word_name"] = 1
    return matches


def personal_data_matches(header: str, value: str) -> dict[str, int]:
    return _personal_data_matches(personal_data_profile(header), value)


def normalize_contact_value(value: str) -> str:
    unwrapped = re.sub(
        rf"(?:'\s*({EMAIL_PATTERN.pattern})\s*'|<\s*({EMAIL_PATTERN.pattern})\s*>)",
        lambda match: next(group for group in (match.group(1), match.group(4)) if group is not None),
        value,
        flags=re.IGNORECASE,
    )
    result: list[str] = []
    position = 0
    for match in EMAIL_PATTERN.finditer(unwrapped):
        result.append(unwrapped[position : match.start()].title())
        result.append(match.group(1))
        position = match.end()
    result.append(unwrapped[position:].title())
    return "".join(result)


def is_begin_header(value: str) -> bool:
    normalized = normalize_header(value)
    return normalized == BEGIN_ALIASES[0] or normalized.startswith(BEGIN_ALIASES[1])


def is_end_header(value: str) -> bool:
    normalized = normalize_header(value)
    return normalized == END_ALIASES[0] or normalized.startswith(END_ALIASES[1])


def rfp_header_label(value: str) -> str | None:
    normalized = value.strip()
    if normalize_header(normalized) == "rfp":
        return None
    match = RFP_NUMBER_PATTERN.match(normalized)
    if not match:
        return None
    return f"RFP {int(match.group(1)):02d}"


def detect_platform(headers: Iterable[str]) -> tuple[Platform, int]:
    """Return the closest vendor header match and an explainable 0-100 confidence score."""
    normalized = {normalize_header(header) for header in headers if normalize_header(header)}
    if not normalized:
        return "unknown", 0

    logikcull_score = 0
    logikcull_score += 40 if "bates/control #" in normalized else 0
    logikcull_score += 40 if "end bates/control #" in normalized else 0
    logikcull_score += min(12, 2 * len(normalized & LOGIKCULL_METADATA_HEADERS))
    logikcull_score += 8 if any(re.fullmatch(r"rfp:\s*rfp\s+\d+", header) for header in normalized) else 0

    everlaw_score = 0
    everlaw_score += 40 if any(header.startswith("begin bates num from") for header in normalized) else 0
    everlaw_score += 40 if any(header.startswith("end bates num from") for header in normalized) else 0
    everlaw_score += min(12, 2 * len(normalized & EVERLAW_METADATA_HEADERS))
    everlaw_score += 8 if any(header.startswith("tag:") for header in normalized) else 0

    leader: Platform
    if logikcull_score >= everlaw_score:
        leader, leader_score, competitor_score = "logikcull", logikcull_score, everlaw_score
    else:
        leader, leader_score, competitor_score = "everlaw", everlaw_score, logikcull_score
    confidence = max(0, min(100, leader_score - competitor_score // 2))
    if confidence < 60 or leader_score - competitor_score < 20:
        return "unknown", confidence
    return leader, confidence


def parse_bates(value: str) -> Bates | None:
    value = value.strip()
    match = BATES_PATTERN.match(value)
    if not match or not match.group(1) or len(match.group(2)) > 18:
        return None
    return Bates(value, match.group(1), match.group(2), int(match.group(2)))


def shorten_bates(begin_value: str, end_value: str) -> str:
    begin = parse_bates(begin_value)
    end = parse_bates(end_value)
    if not begin or not end or begin.prefix != end.prefix:
        return "-".join(value for value in (begin_value.strip(), end_value.strip()) if value)
    width = max(len(begin.number_text), len(end.number_text))
    begin_number = begin.number_text.zfill(width)
    end_number = end.number_text.zfill(width)
    full_begin = f"{begin.prefix}{begin_number}"
    if begin.number == end.number:
        return full_begin
    shared = 0
    for left, right in zip(begin_number, end_number, strict=False):
        if left != right:
            break
        shared += 1
    suffix_length = max(width - shared, min(4, width))
    shortened_end = end_number[-suffix_length:]
    return f"{full_begin}-{shortened_end}"


def escape_formula(value: str) -> tuple[str, bool]:
    if value.lstrip().startswith(FORMULA_PREFIXES):
        return f"'{value}", True
    return value, False


def _byte_issues(path: Path) -> list[Issue]:
    issues: list[Issue] = []
    with path.open("rb") as handle:
        first = handle.read(4)
        handle.seek(0)
        has_nul = False
        invalid_utf8 = False
        decoder = codecs.getincrementaldecoder("utf-8-sig")(errors="strict")
        while chunk := handle.read(1024 * 1024):
            if b"\x00" in chunk:
                has_nul = True
            if not invalid_utf8:
                try:
                    decoder.decode(chunk)
                except UnicodeDecodeError:
                    invalid_utf8 = True
        if not invalid_utf8:
            try:
                decoder.decode(b"", final=True)
            except UnicodeDecodeError:
                invalid_utf8 = True
    if invalid_utf8:
        issues.append(Issue(code="invalid_utf8", severity="fatal", message="The file is not valid UTF-8."))
    if b"\x00" in first or has_nul:
        issues.append(Issue(code="embedded_nul", severity="fatal", message="The file contains embedded NUL bytes."))
    if first.startswith((b"\xff\xfe", b"\xfe\xff", b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
        issues.append(
            Issue(
                code="incompatible_encoding_marker",
                severity="fatal",
                message="The file uses an unsupported encoding marker.",
            )
        )
    return issues


def _make_issue(code: str, *, row: int | None = None, column: str | None = None) -> Issue:
    messages = {
        "empty_file": "The CSV is empty.",
        "no_data_rows": "The CSV contains headers but no data rows.",
        "uneven_row_width": "One or more rows have a different number of cells than the header.",
        "broken_quote": "The CSV contains an unterminated or malformed quoted field.",
        "truncated_record": "The CSV appears to end during a record.",
        "duplicate_begin_bates_header": "The Begin Bates header appears more than once.",
        "duplicate_header": "The CSV contains duplicate column headers.",
        "blank_header": "The CSV contains a blank column header.",
        "conflicting_required_columns": "Required columns are duplicated or conflict.",
        "missing_begin_bates_column": "A Begin Bates column was not found.",
        "missing_end_bates_column": "An End Bates column was not found.",
        "blank_begin_bates": "One or more rows have a blank Begin Bates value.",
        "blank_end_bates": "One or more rows have a blank End Bates value.",
        "malformed_bates": "One or more Bates values cannot be parsed.",
        "reversed_range": "One or more Bates ranges end before they begin.",
        "prefix_mismatch": "One or more Bates ranges use different begin and end prefixes.",
        "inconsistent_padding": "One or more Bates ranges use inconsistent numeric padding.",
        "numeric_overflow": "One or more Bates numbers exceed the supported width.",
    }
    fatal_codes = {"broken_quote", "truncated_record"}
    warning_codes = {
        "uneven_row_width",
        "blank_begin_bates",
        "blank_end_bates",
        "malformed_bates",
        "reversed_range",
        "prefix_mismatch",
        "inconsistent_padding",
        "numeric_overflow",
    }
    severity: IssueSeverity = "fatal" if code in fatal_codes else ("warning" if code in warning_codes else "error")
    return Issue(
        code=code,
        severity=severity,
        message=messages[code],
        overrideable=severity == "warning",
        row=row,
        column=column,
    )


def _collapse_issues(issues: list[Issue]) -> list[Issue]:
    collapsed: dict[tuple[str, str | None], Issue] = {}
    for issue in issues:
        key = (issue.code, issue.column)
        if key in collapsed:
            collapsed[key].count += 1
            if collapsed[key].row is None:
                collapsed[key].row = issue.row
        else:
            collapsed[key] = issue.model_copy()
    return list(collapsed.values())


def analyze_csv(path: Path, filename: str) -> Analysis:
    size = path.stat().st_size
    if size == 0:
        return Analysis(filename=filename, size_bytes=0, issues=[_make_issue("empty_file")])
    byte_issues = _byte_issues(path)
    if byte_issues:
        return Analysis(filename=filename, size_bytes=size, issues=byte_issues)

    issue_map: dict[tuple[str, str | None], Issue] = {}

    def record_issue(issue: Issue) -> None:
        key = (issue.code, issue.column)
        existing = issue_map.get(key)
        if existing:
            existing.count += issue.count
            if existing.row is None:
                existing.row = issue.row
        else:
            issue_map[key] = issue

    headers: list[str] = []
    row_count = 0
    prefixes: set[str] = set()
    duplicate_ranges = 0
    range_store = sqlite3.connect("")
    range_store.execute("PRAGMA journal_mode=OFF")
    range_store.execute("PRAGMA synchronous=OFF")
    range_store.execute("PRAGMA temp_store=FILE")
    range_store.execute(
        "CREATE TABLE analyzed_ranges ("
        "label TEXT NOT NULL, prefix TEXT NOT NULL, width INTEGER NOT NULL, "
        "begin_number INTEGER NOT NULL, end_number INTEGER NOT NULL, "
        "UNIQUE(label,prefix,width,begin_number,end_number))"
    )
    begin_indices: list[int] = []
    end_indices: list[int] = []
    combined_rfp_index: int | None = None
    separate_rfp: dict[int, str] = {}
    personal_counts: dict[str, int] = defaultdict(int)
    personal_columns: dict[str, set[str]] = defaultdict(set)
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            try:
                headers = next(reader)
            except StopIteration:
                range_store.close()
                return Analysis(filename=filename, size_bytes=size, issues=[_make_issue("empty_file")])
            personal_profiles = [personal_data_profile(header) for header in headers]
            normalized_positions: dict[str, list[int]] = defaultdict(list)
            for position, header in enumerate(headers, start=1):
                normalized = normalize_header(header)
                if not normalized:
                    record_issue(_make_issue("blank_header", column=f"column {position}"))
                else:
                    normalized_positions[normalized].append(position)
            for positions in normalized_positions.values():
                if len(positions) > 1:
                    record_issue(_make_issue("duplicate_header", column="columns " + ", ".join(map(str, positions))))
            begin_indices = [i for i, value in enumerate(headers) if is_begin_header(value)]
            end_indices = [i for i, value in enumerate(headers) if is_end_header(value)]
            for index, header in enumerate(headers):
                if normalize_header(header) == "rfp":
                    combined_rfp_index = index
                label = rfp_header_label(header)
                if label:
                    separate_rfp[index] = label
            if len(begin_indices) > 1:
                record_issue(_make_issue("duplicate_begin_bates_header"))
                record_issue(_make_issue("conflicting_required_columns"))
            if len(end_indices) > 1:
                record_issue(_make_issue("conflicting_required_columns"))
            if not begin_indices:
                record_issue(_make_issue("missing_begin_bates_column"))
            if not end_indices:
                record_issue(_make_issue("missing_end_bates_column"))
            for row_number, row in enumerate(reader, start=2):
                row_count += 1
                for profile, value in zip(personal_profiles, row, strict=False):
                    for category, count in _personal_data_matches(profile, value).items():
                        personal_counts[category] += count
                        personal_columns[category].add(profile.header)
                if len(row) != len(headers):
                    record_issue(_make_issue("uneven_row_width", row=row_number))
                    continue
                if not begin_indices or not end_indices:
                    continue
                begin_raw = row[begin_indices[0]].strip()
                end_raw = row[end_indices[0]].strip()
                if not begin_raw:
                    record_issue(_make_issue("blank_begin_bates", row=row_number, column=headers[begin_indices[0]]))
                if not end_raw:
                    record_issue(_make_issue("blank_end_bates", row=row_number, column=headers[end_indices[0]]))
                if not begin_raw or not end_raw:
                    continue
                begin_match = BATES_PATTERN.match(begin_raw)
                end_match = BATES_PATTERN.match(end_raw)
                if begin_match and end_match and (len(begin_match.group(2)) > 18 or len(end_match.group(2)) > 18):
                    if len(begin_match.group(2)) != len(end_match.group(2)):
                        record_issue(_make_issue("inconsistent_padding", row=row_number))
                    record_issue(_make_issue("numeric_overflow", row=row_number))
                    continue
                begin = parse_bates(begin_raw)
                end = parse_bates(end_raw)
                if not begin or not end:
                    record_issue(_make_issue("malformed_bates", row=row_number))
                    continue
                if len(begin.number_text) != len(end.number_text):
                    record_issue(_make_issue("inconsistent_padding", row=row_number))
                if begin.prefix != end.prefix:
                    record_issue(_make_issue("prefix_mismatch", row=row_number))
                    continue
                if end.number < begin.number:
                    record_issue(_make_issue("reversed_range", row=row_number))
                    continue
                prefixes.add(begin.prefix)
                request_labels: list[str] = []
                if combined_rfp_index is not None and row[combined_rfp_index].strip():
                    request_labels = [row[combined_rfp_index].strip()]
                else:
                    request_labels = [
                        label
                        for index, label in separate_rfp.items()
                        if row[index].strip().casefold() in {"yes", "true", "1", "x"}
                    ]
                for label in request_labels:
                    number_match = RFP_NUMBER_PATTERN.match(label)
                    canonical = f"RFP {int(number_match.group(1)):02d}" if number_match else label
                    inserted = range_store.execute(
                        "INSERT OR IGNORE INTO analyzed_ranges VALUES (?,?,?,?,?)",
                        (canonical, begin.prefix, len(begin.number_text), begin.number, end.number),
                    )
                    if inserted.rowcount == 0:
                        duplicate_ranges += 1
    except csv.Error:
        record_issue(_make_issue("uneven_row_width"))
        record_issue(_make_issue("broken_quote"))
        record_issue(_make_issue("truncated_record"))

    if row_count == 0 and headers:
        record_issue(_make_issue("no_data_rows"))
    platform, platform_confidence = detect_platform(headers)
    workflow: DetectedWorkflow = "rfp_ranges" if combined_rfp_index is not None or separate_rfp else "privilege_log"
    gap_count = 0
    current_key: tuple[str, str, int] | None = None
    merged_end: int | None = None
    for label, prefix, width, begin_number, end_number in range_store.execute(
        "SELECT label,prefix,width,begin_number,end_number FROM analyzed_ranges "
        "ORDER BY label,prefix,width,begin_number,end_number"
    ):
        key = (label, prefix, width)
        if key != current_key:
            current_key = key
            merged_end = None
        if merged_end is not None and begin_number > merged_end + 1:
            gap_count += 1
        merged_end = end_number if merged_end is None else max(merged_end, end_number)
    request_count = int(range_store.execute("SELECT COUNT(DISTINCT label) FROM analyzed_ranges").fetchone()[0])
    range_store.close()
    category_order: tuple[PersonalDataCategory, ...] = (
        "ssn",
        "date_of_birth",
        "personal_email",
        "single_word_name",
    )
    personal_data_findings = [
        PersonalDataFinding(
            category=category, count=personal_counts[category], columns=sorted(personal_columns[category])
        )
        for category in category_order
        if personal_counts[category]
    ]
    return Analysis(
        filename=filename,
        size_bytes=size,
        row_count=row_count,
        column_count=len(headers),
        headers=headers,
        platform=platform,
        platform_confidence=platform_confidence,
        detected_workflow=workflow,
        rfp_layout="combined" if combined_rfp_index is not None else ("separate" if separate_rfp else None),
        begin_bates_header=headers[begin_indices[0]] if begin_indices else None,
        end_bates_header=headers[end_indices[0]] if end_indices else None,
        prefixes=sorted(prefixes),
        request_count=request_count,
        duplicate_ranges=duplicate_ranges,
        gap_count=gap_count,
        issues=list(issue_map.values()),
        personal_data_findings=personal_data_findings,
    )


def _iter_dict_rows(path: Path) -> Iterator[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, strict=True)
        headers = next(reader)
        for row in reader:
            if len(row) != len(headers):
                continue
            yield dict(zip(headers, row, strict=True))


def _valid_bates_pair(begin_value: str, end_value: str) -> tuple[Bates, Bates] | None:
    begin, end = parse_bates(begin_value), parse_bates(end_value)
    if not begin or not end or begin.prefix != end.prefix or end.number < begin.number:
        return None
    return begin, end


def _populate_rfp_spool(
    path: Path, analysis: Analysis, database: Path, max_bytes: int | None = None
) -> tuple[sqlite3.Connection, int]:
    headers = analysis.headers
    begin_header = analysis.begin_bates_header
    end_header = analysis.end_bates_header
    if not begin_header or not end_header:
        connection = sqlite3.connect(database)
        connection.execute(
            "CREATE TABLE ranges (label TEXT, prefix TEXT, width INTEGER, begin_number TEXT, end_number TEXT)"
        )
        return connection, analysis.row_count
    combined = next((header for header in headers if normalize_header(header) == "rfp"), None)
    separate: dict[str, str] = {}
    for header in headers:
        if label := rfp_header_label(header):
            separate[header] = label
    connection = sqlite3.connect(database)
    if max_bytes is not None:
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
        connection.execute(f"PRAGMA max_page_count={max(1, max_bytes // page_size)}")
    connection.execute("PRAGMA journal_mode=OFF")
    connection.execute("PRAGMA synchronous=OFF")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute(
        "CREATE TABLE ranges (label TEXT NOT NULL, prefix TEXT NOT NULL, width INTEGER NOT NULL, "
        "begin_number TEXT NOT NULL, end_number TEXT NOT NULL)"
    )
    skipped = 0
    pending: list[tuple[str, str, int, str, str]] = []

    def insert_pending_rows() -> None:
        try:
            connection.executemany("INSERT INTO ranges VALUES (?, ?, ?, ?, ?)", pending)
        except BaseException:
            connection.close()
            raise

    for row in _iter_dict_rows(path):
        pair = _valid_bates_pair(row.get(begin_header, ""), row.get(end_header, ""))
        if not pair:
            skipped += 1
            continue
        begin, end = pair
        labels: list[str]
        if combined and row.get(combined, "").strip():
            raw = row[combined].strip()
            match = RFP_NUMBER_PATTERN.match(raw)
            labels = [f"RFP {int(match.group(1)):02d}" if match else raw]
        else:
            labels = [
                label
                for header, label in separate.items()
                if row.get(header, "").strip().casefold() in {"yes", "true", "1", "x"} and label
            ]
        for label in labels:
            match = RFP_NUMBER_PATTERN.match(label)
            sort_label = f"0:{int(match.group(1)):020d}" if match else f"1:{label.casefold()}"
            pending.append(
                (sort_label + "\x00" + label, begin.prefix, len(begin.number_text), begin.number_text, end.number_text)
            )
            if len(pending) >= 10_000:
                insert_pending_rows()
                pending.clear()
    if pending:
        insert_pending_rows()
    try:
        connection.execute("CREATE INDEX ranges_order ON ranges(label, prefix, width, begin_number, end_number)")
    except BaseException:
        connection.close()
        raise
    connection.commit()
    return connection, skipped


def _iter_merged_rfp_rows(connection: sqlite3.Connection) -> Iterator[list[str]]:
    current_key: tuple[str, str, int] | None = None
    current_begin = 0
    current_end = 0
    for stored_label, prefix, width, begin_text, end_text in connection.execute(
        "SELECT label, prefix, width, begin_number, end_number FROM ranges "
        "GROUP BY label, prefix, width, begin_number, end_number "
        "ORDER BY label, prefix, width, begin_number, end_number"
    ):
        _, label = stored_label.split("\x00", 1)
        begin = int(begin_text)
        end = int(end_text)
        key = (label, prefix, width)
        if current_key == key and begin <= current_end + 1:
            current_end = max(current_end, end)
            continue
        if current_key is not None:
            old_label, old_prefix, old_width = current_key
            yield [
                old_label,
                f"{old_prefix}{current_begin:0{old_width}d}",
                f"{old_prefix}{current_end:0{old_width}d}",
            ]
        current_key = key
        current_begin, current_end = begin, end
    if current_key is not None:
        label, prefix, width = current_key
        yield [label, f"{prefix}{current_begin:0{width}d}", f"{prefix}{current_end:0{width}d}"]


def rfp_output_rows(path: Path, analysis: Analysis) -> tuple[list[str], list[list[str]], int]:
    with tempfile.TemporaryDirectory(prefix="production-tool-rfp-") as temporary:
        connection, skipped = _populate_rfp_spool(path, analysis, Path(temporary) / "ranges.sqlite")
        try:
            output = list(_iter_merged_rfp_rows(connection))
        finally:
            connection.close()
    return ["RFP", "Begin Bates", "End Bates"], output, skipped


def iter_privilege_output_rows(path: Path, mapping: MappingConfig) -> Iterator[list[str]]:
    for row in _iter_dict_rows(path):
        result: list[str] = []
        for column in mapping.columns:
            values = [row.get(field, "") for field in column.source_fields]
            if column.transform.kind == "none":
                result.append(values[0])
            elif column.transform.kind == "shorten_bates":
                result.append(shorten_bates(values[0], values[1]))
            elif column.transform.kind == "fill":
                result.append(next((value for value in values if value.strip()), ""))
            else:
                result.append((column.transform.delimiter or "; ").join(value for value in values if value.strip()))
            if column.normalize:
                result[-1] = normalize_contact_value(result[-1])
        yield result


def rfp_preview_rows(rows: Iterable[list[str]]) -> list[list[str]]:
    return [[label, shorten_bates(begin, end)] for label, begin, end in rows]


def _join_rfp_ranges(ranges: list[str], settings: PleadingSettings) -> str:
    if not ranges:
        return ""
    if len(ranges) == 1:
        return ranges[0]
    separator = {
        "comma": ", ",
        "semicolon": "; ",
        "pipe": " | ",
        "newline": "\r\n",
    }[settings.delimiter]
    if not settings.include_and:
        return separator.join(ranges)
    if len(ranges) == 2:
        return f"{ranges[0]} and {ranges[1]}"
    return f"{separator.join(ranges[:-1])}{separator}and {ranges[-1]}"


def render_rfp_text(rows: Iterable[list[str]], settings: PleadingSettings | None = None) -> str:
    effective_settings = settings or PleadingSettings()
    groups: list[tuple[str, list[str]]] = []
    for label, begin, end in rows:
        if not groups or groups[-1][0] != label:
            groups.append((label, []))
        groups[-1][1].append(shorten_bates(begin, end))
    sections = [f"{label}\r\n{_join_rfp_ranges(ranges, effective_settings)}" for label, ranges in groups]
    return "\r\n\r\n".join(sections) + ("\r\n" if sections else "")


def _write_rfp_text(handle, rows: Iterator[list[str]], settings: PleadingSettings) -> int:
    """Write grouped RFP text with one-row lookahead and constant memory."""
    separator = {
        "comma": ", ",
        "semicolon": "; ",
        "pipe": " | ",
        "newline": "\r\n",
    }[settings.delimiter]
    iterator = iter(rows)
    current = next(iterator, None)
    previous_label: str | None = None
    group_position = 0
    output_rows = 0
    while current is not None:
        following = next(iterator, None)
        label, begin, end = current
        value = shorten_bates(begin, end)
        if label != previous_label:
            if previous_label is not None:
                handle.write("\r\n\r\n")
            handle.write(f"{label}\r\n")
            group_position = 0
        else:
            is_last = following is None or following[0] != label
            if settings.include_and and is_last and group_position == 1:
                handle.write(" and ")
            else:
                handle.write(separator)
                if settings.include_and and is_last:
                    handle.write("and ")
        handle.write(value)
        previous_label = label
        group_position += 1
        output_rows += 1
        current = following
    if output_rows:
        handle.write("\r\n")
    return output_rows


def build_preview(
    path: Path,
    analysis: Analysis,
    workflow: str,
    mapping: MappingConfig | None,
    limit: int = 5,
    pleading_settings: PleadingSettings | None = None,
) -> Preview:
    text: str | None = None
    header_escapes = 0
    sample_truncated = False
    rows: Iterable[list[str]]
    if workflow == "rfp_ranges":
        headers = ["RFP", "Bates Range"]
        with tempfile.TemporaryDirectory(prefix="production-tool-preview-") as temporary:
            connection, skipped = _populate_rfp_spool(path, analysis, Path(temporary) / "ranges.sqlite")
            try:
                iterator = _iter_merged_rfp_rows(connection)
                sample_rows = list(islice(iterator, limit))
                counted_rows = len(sample_rows) + sum(1 for _ in iterator)
            finally:
                connection.close()
        text = render_rfp_text(sample_rows, pleading_settings)
        rows = rfp_preview_rows(sample_rows)
    elif mapping:
        escaped_headers = [escape_formula(column.name) for column in mapping.columns]
        headers = [value for value, _ in escaped_headers]
        header_escapes = sum(int(changed) for _, changed in escaped_headers)
        rows = islice(iter_privilege_output_rows(path, mapping), limit)
        skipped = sum(issue.count for issue in analysis.issues if issue.code == "uneven_row_width")
        total_rows = analysis.row_count - sum(
            issue.count for issue in analysis.issues if issue.code == "uneven_row_width"
        )
    else:
        return Preview(headers=[], rows=[], total_rows=0, skipped_rows=0, formula_escapes=0)
    escaped = 0
    safe_rows: list[list[str]] = []
    counted_rows = counted_rows if workflow == "rfp_ranges" else 0
    for row in rows:
        if workflow != "rfp_ranges":
            counted_rows += 1
        safe_row = []
        for value in row:
            safe, changed = escape_formula(value)
            sample_truncated = sample_truncated or len(safe) > 500
            safe_row.append(safe[:500])
            escaped += int(changed)
        safe_rows.append(safe_row)
    if workflow == "rfp_ranges":
        total_rows = counted_rows
    return Preview(
        headers=headers,
        rows=safe_rows,
        total_rows=total_rows,
        skipped_rows=skipped,
        formula_escapes=escaped + header_escapes,
        sample_truncated=sample_truncated,
        text=text,
    )


def build_artifact_preview(
    path: Path,
    workflow: str,
    stats: OutputStats,
    *,
    limit: int = 5,
    artifact_sha256: str,
    configuration_revision: int,
    review_token: str,
) -> Preview:
    """Read the review sample from the staged bytes that will be finalized."""
    if workflow == "rfp_ranges":
        full_text = path.read_bytes().decode("utf-8")
        excerpt_limit = 5_000
        return Preview(
            headers=["RFP", "Bates Range"],
            rows=[],
            total_rows=stats.output_rows,
            skipped_rows=stats.skipped_rows,
            formula_escapes=stats.formula_escapes,
            artifact_sha256=artifact_sha256,
            configuration_revision=configuration_revision,
            sample_truncated=len(full_text) > excerpt_limit,
            review_token=review_token,
            text=full_text[:excerpt_limit],
        )
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, strict=True)
        headers = next(reader, [])
        sample: list[list[str]] = []
        truncated = False
        for row in islice(reader, limit):
            display_row: list[str] = []
            for value in row:
                truncated = truncated or len(value) > 500
                display_row.append(value[:500])
            sample.append(display_row)
    return Preview(
        headers=headers,
        rows=sample,
        total_rows=stats.output_rows,
        skipped_rows=stats.skipped_rows,
        formula_escapes=stats.formula_escapes,
        artifact_sha256=artifact_sha256,
        configuration_revision=configuration_revision,
        sample_truncated=truncated,
        review_token=review_token,
    )


def write_output(
    path: Path,
    source: Path,
    analysis: Analysis,
    workflow: str,
    mapping: MappingConfig | None,
    overridden: int,
    pleading_settings: PleadingSettings | None = None,
    max_work_bytes: int | None = None,
) -> OutputStats:
    started = time.perf_counter()
    if workflow == "rfp_ranges":
        effective_settings = pleading_settings or PleadingSettings()
        with tempfile.TemporaryDirectory(prefix="production-tool-output-") as temporary:
            try:
                connection, skipped = _populate_rfp_spool(
                    source, analysis, Path(temporary) / "ranges.sqlite", max_work_bytes
                )
            except sqlite3.DatabaseError as exc:
                if "full" in str(exc).casefold():
                    raise ProcessingLimitError("RFP processing exceeded the configured scratch-space limit") from exc
                raise
            try:
                with path.open("w", encoding="utf-8", newline="") as handle:
                    output_rows = _write_rfp_text(handle, _iter_merged_rfp_rows(connection), effective_settings)
            finally:
                connection.close()
        if output_rows == 0:
            path.unlink(missing_ok=True)
            raise ProcessingLimitError("The selected workflow produced no recoverable output rows")
        if max_work_bytes is not None and path.stat().st_size > max_work_bytes:
            path.unlink(missing_ok=True)
            raise ProcessingLimitError("Generated output exceeded the configured per-job work limit")
        return OutputStats(
            processing_ms=round((time.perf_counter() - started) * 1000),
            input_rows=analysis.row_count,
            output_rows=output_rows,
            output_columns=2,
            output_cells=output_rows * 2,
            output_size_bytes=path.stat().st_size,
            skipped_rows=skipped,
            formula_escapes=0,
            warnings_overridden=overridden,
        )
    elif mapping:
        escaped_headers = [escape_formula(column.name) for column in mapping.columns]
        headers = [header for header, _ in escaped_headers]
        rows = iter_privilege_output_rows(source, mapping)
        skipped = sum(issue.count for issue in analysis.issues if issue.code == "uneven_row_width")
    else:
        raise ValueError("A privilege mapping is required")
    escapes = sum(int(changed) for _, changed in escaped_headers)
    output_rows = 0
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\r\n")
        writer.writerow(headers)
        for row in rows:
            output_rows += 1
            safe_row: list[str] = []
            for value in row:
                safe, changed = escape_formula(value)
                safe_row.append(safe)
                escapes += int(changed)
            writer.writerow(safe_row)
            if max_work_bytes is not None and handle.tell() > max_work_bytes:
                raise ProcessingLimitError("Generated output exceeded the configured per-job work limit")
    if output_rows == 0:
        path.unlink(missing_ok=True)
        raise ProcessingLimitError("The selected workflow produced no recoverable output rows")
    return OutputStats(
        processing_ms=round((time.perf_counter() - started) * 1000),
        input_rows=analysis.row_count,
        output_rows=output_rows,
        output_columns=len(headers),
        output_cells=output_rows * len(headers),
        output_size_bytes=path.stat().st_size,
        skipped_rows=skipped,
        formula_escapes=escapes,
        warnings_overridden=overridden,
    )
