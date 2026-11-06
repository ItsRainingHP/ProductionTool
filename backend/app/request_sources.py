"""Matter-specific request codes, independent of the source platform guess."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from .models import Issue, PleadingSettings, RequestCandidate, RequestSource

NUMBER = re.compile(r"^(?:tag:\s*)?(rfp|rog)(?:\s*:\s*(?:rfp|rog))?\s*(\d+)\b", re.IGNORECASE)
NEXT_REQUEST = re.compile(r"[;,](?=\s*(?:tag:\s*)?(?:rfp|rog)(?:\s*:\s*(?:rfp|rog))?\s*\d+\b)", re.I)
REQUEST_NAME = re.compile(r"\b(?:rfps?|rogs?)\b|requests?\s+for\s+(?:production|documents)", re.I)
AFFIRMATIVE = {"yes", "true", "1", "x"}
NEGATIVE = {"", "null", "false", "no", "0"}
SEPARATORS = {"semicolon": ";", "comma": ",", "pipe": "|", "newline": "\n"}
REQUEST_ISSUE_CODES = {"unexpected_request_value", "ambiguous_request_separator"}


def normalized(value: str) -> str:
    return " ".join(value.split()).casefold()


def header_parts(header: str) -> tuple[str, str]:
    category, colon, code = header.strip().partition(":")
    return (category.strip(), code.strip()) if colon else ("", category)


def legacy_header_label(header: str) -> str | None:
    match = NUMBER.match(header.strip())
    if match and len(match.group(2)) > 18:
        return None
    return f"{match.group(1).upper()} {int(match.group(2)):02d}" if match else None


def legacy_cell_labels(value: str) -> list[str]:
    labels: list[str] = []
    for part in NEXT_REQUEST.split(value):
        part = part.strip()
        if not part or normalized(part) == "null":
            continue
        match = NUMBER.match(part)
        if match and len(match.group(2)) > 18:
            match = None
        label = f"{match.group(1).upper()} {int(match.group(2)):02d}{part[match.end():]}" if match else part
        if label not in labels:
            labels.append(label)
    return labels


def candidates(headers: Iterable[str]) -> list[RequestCandidate]:
    result = []
    for header in headers:
        if not header.strip():
            continue
        category, code = header_parts(header)
        combined = normalized(header) == "rfp"
        result.append(RequestCandidate(
            column=header, category=category, code=code,
            layout="category" if combined or normalized(header) in {
                "rfps", "rogs", "requests for production", "requests for documents",
            } else "individual",
            input_separator="legacy" if combined else "auto",
            suggested=bool(REQUEST_NAME.search(header)),
        ))
    return result


def observe_candidate(candidate: RequestCandidate, value: str) -> None:
    value = value.strip()
    if normalized(value) in NEGATIVE:
        return
    if len(candidate.samples) < 3 and value[:256] not in candidate.samples:
        candidate.samples.append(value[:256])
    if not candidate.category and re.match(re.escape(candidate.column.strip()) + r"\s*:", value, re.I):
        candidate.layout = "category"


class RequestConfigurationError(ValueError):
    def __init__(self, message: str, issues: list[Issue] | None = None):
        super().__init__(message)
        self.issues = issues or []


@dataclass(frozen=True)
class Assignment:
    category: str
    code: str
    source_order: int = 0

    @property
    def identity(self) -> str:
        return json.dumps([self.category, self.code], ensure_ascii=False)


class RequestExtractor:
    """One extraction policy for analysis and every generated artifact."""

    def __init__(
        self, headers: list[str], settings: PleadingSettings | None = None,
        inferred_candidates: list[RequestCandidate] | None = None,
    ):
        explicit = settings is not None and settings.request_sources is not None
        self.legacy = not explicit
        selected = settings.request_sources if explicit and settings else [
            candidate for candidate in (inferred_candidates or candidates(headers)) if candidate.suggested
        ]
        positions = {header: index for index, header in enumerate(headers)}
        self.sources: list[RequestSource] = sorted(selected or [], key=lambda source: positions[source.column])
        self.issues: dict[tuple[str, str], Issue] = {}

    def _issue(self, code: str, source: RequestSource, row: int) -> None:
        key = code, source.column
        if key in self.issues:
            self.issues[key].count += 1
            return
        message = (
            "Choose an input code separator or Single code for this category column before reviewing."
            if code == "ambiguous_request_separator" else
            "Some values do not match this individual code and will be omitted. Check the source layout and values."
        )
        self.issues[key] = Issue(
            code=code, severity="error" if code == "ambiguous_request_separator" else "warning",
            overrideable=code == "unexpected_request_value", message=message, column=source.column, row=row,
        )

    def _category_codes(self, source: RequestSource, value: str, row: int) -> list[Assignment]:
        if source.input_separator == "legacy":
            return [Assignment("", code) for code in legacy_cell_labels(value)]
        category = source.column.strip()
        prefix = re.compile(r"^" + re.escape(category) + r"\s*:\s*", re.I)
        if source.input_separator in SEPARATORS:
            parts = value.split(SEPARATORS[source.input_separator])
        elif source.input_separator == "single":
            parts = [value]
        else:
            boundary = re.compile(r"[;,|\r\n\x13]+\s*(?=" + re.escape(category) + r"\s*:)", re.I)
            parts = boundary.split(value)
            if len(parts) == 1 and re.search(r"[;,|\r\n\x13]", value):
                self._issue("ambiguous_request_separator", source, row)
                return []
        return [Assignment(category, prefix.sub("", part.strip(), count=1))
                for part in parts if normalized(part) not in {"", "null"} and prefix.sub("", part.strip(), count=1)]

    def extract(self, row: Mapping[str, str], row_number: int = 0) -> list[Assignment]:
        assignments: dict[str, Assignment] = {}
        legacy_combined = next((s for s in self.sources if normalized(s.column) == "rfp"), None)
        sources = self.sources
        if self.legacy and legacy_combined and normalized(row.get(legacy_combined.column, "")) not in NEGATIVE:
            sources = [legacy_combined]
        for source_order, source in enumerate(sources):
            value = row.get(source.column, "").strip()
            if normalized(value) in {"", "null"}:
                continue
            if source.layout == "category":
                extracted = self._category_codes(source, value, row_number)
            else:
                category, code = header_parts(source.column)
                matched = normalized(value) in AFFIRMATIVE or normalized(value) in {
                    normalized(source.column), normalized(code),
                }
                if not matched or not code:
                    if normalized(value) not in NEGATIVE:
                        self._issue("unexpected_request_value", source, row_number)
                    continue
                legacy_label = legacy_header_label(source.column) if self.legacy else None
                extracted = [Assignment("" if legacy_label else category, legacy_label or code)]
            for assignment in extracted:
                assignments.setdefault(assignment.identity, Assignment(
                    assignment.category, assignment.code, source_order,
                ))
        return list(assignments.values())

    def require_acknowledgments(self, acknowledged: Iterable[str] = ()) -> None:
        pending = [issue for issue in self.issues.values()
                   if not issue.overrideable or issue.code not in acknowledged]
        if pending:
            raise RequestConfigurationError("Check the request source settings and listed issues.", pending)
