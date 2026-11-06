# Author: Brent Coleman
# Copyright (c) 2026 Brent Coleman
# SPDX-License-Identifier: MIT

"""Validated API models for jobs, mappings, analysis, and generated output."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

type IssueSeverity = Literal["warning", "error", "fatal"]
type PersonalDataCategory = Literal["ssn", "date_of_birth", "personal_email", "single_word_name"]
type Platform = Literal["logikcull", "everlaw", "unknown"]
type DetectedWorkflow = Literal["rfp_ranges", "privilege_log", "unknown"]
type JobWorkflow = Literal["rfp_ranges", "privilege_log"]


class SystemStatus(BaseModel):
    current_version: str
    latest_version: str | None
    update_available: bool


class JobStatus(StrEnum):
    awaiting_upload = "awaiting_upload"
    uploading = "uploading"
    analyzing = "analyzing"
    needs_configuration = "needs_configuration"
    preparing_review = "preparing_review"
    ready_for_review = "ready_for_review"
    processing = "processing"
    complete = "complete"
    failed = "failed"
    expired = "expired"


class Issue(BaseModel):
    code: str
    severity: IssueSeverity
    message: str
    overrideable: bool = False
    row: int | None = None
    column: str | None = None
    count: int = 1


class JobProgress(BaseModel):
    phase: str = "Waiting for upload"
    percent: int = Field(default=0, ge=0, le=100)
    bytes_processed: int = 0
    rows_processed: int = 0


class PersonalDataFinding(BaseModel):
    category: PersonalDataCategory
    count: int = Field(ge=1)
    columns: list[str] = Field(min_length=1)


class RequestSource(BaseModel):
    column: str = Field(min_length=1)
    layout: Literal["individual", "category"] = "individual"
    input_separator: Literal["auto", "single", "semicolon", "comma", "pipe", "newline", "legacy"] = "auto"


class RequestCandidate(RequestSource):
    category: str = ""
    code: str = ""
    suggested: bool = False
    samples: list[str] = Field(default_factory=list)


class Analysis(BaseModel):
    filename: str
    size_bytes: int
    row_count: int = 0
    column_count: int = 0
    headers: list[str] = Field(default_factory=list)
    true_blank_headers: list[str] = Field(default_factory=list)
    platform: Platform = "unknown"
    platform_confidence: int = Field(default=0, ge=0, le=100)
    detected_workflow: DetectedWorkflow = "unknown"
    rfp_layout: Literal["combined", "separate"] | None = None
    begin_bates_header: str | None = None
    end_bates_header: str | None = None
    prefixes: list[str] = Field(default_factory=list)
    request_count: int = 0
    request_candidates: list[RequestCandidate] = Field(default_factory=list)
    duplicate_ranges: int = 0
    gap_count: int = 0
    issues: list[Issue] = Field(default_factory=list)
    personal_data_findings: list[PersonalDataFinding] = Field(default_factory=list)


class MappingTransform(BaseModel):
    kind: Literal["none", "shorten_bates", "delimit", "fill"] = "none"
    delimiter: Literal["; ", ", ", " | ", "\n"] | None = None


class OutputColumn(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=120)
    source_fields: list[str] = Field(min_length=1, max_length=100)
    transform: MappingTransform = Field(default_factory=MappingTransform)
    normalize: bool = False
    replace_true_with_header: bool = False

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Column name cannot be blank")
        if any(ord(character) < 32 for character in value):
            raise ValueError("Column names cannot contain control characters")
        return value

    @model_validator(mode="after")
    def validate_transform(self) -> OutputColumn:
        if len(self.source_fields) != len(set(self.source_fields)):
            raise ValueError("A source field can only appear once within an output column")
        if self.transform.kind == "none" and len(self.source_fields) != 1:
            raise ValueError("The None transform requires exactly one source field")
        if self.transform.kind == "shorten_bates" and len(self.source_fields) != 2:
            raise ValueError("Shorten Bates requires Begin and End fields")
        if self.transform.kind == "shorten_bates" and self.replace_true_with_header:
            raise ValueError("TRUE replacement is not available for Bates range columns")
        if self.transform.kind == "delimit" and not self.transform.delimiter:
            raise ValueError("Delimited columns require a delimiter")
        return self


class MappingConfig(BaseModel):
    columns: list[OutputColumn] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_names_and_assignments(self) -> MappingConfig:
        names = [column.name.casefold() for column in self.columns]
        if len(names) != len(set(names)):
            raise ValueError("Output column names must be unique")
        return self


class MappingRequest(MappingConfig):
    """Accept old job-wide requests without exposing the legacy flag in saved mappings."""

    replace_true_with_header: bool | None = Field(default=None, exclude=True, json_schema_extra={"deprecated": True})

    @model_validator(mode="after")
    def unambiguous_replacement(self) -> MappingRequest:
        if "replace_true_with_header" in self.model_fields_set and (
            self.replace_true_with_header is None
            or any("replace_true_with_header" in column.model_fields_set for column in self.columns)
        ):
            raise ValueError(
                "Use per-column TRUE settings without the legacy job-wide setting. "
                "Reload the application or update the mapping request."
            )
        return self

    def to_config(self, platform: Platform) -> MappingConfig:
        if self.replace_true_with_header is None:
            return MappingConfig(columns=self.columns)
        enabled = self.replace_true_with_header and platform == "logikcull"
        return MappingConfig(
            columns=[
                column.model_copy(
                    update={
                        "replace_true_with_header": enabled and column.transform.kind != "shorten_bates",
                    }
                )
                for column in self.columns
            ]
        )


def migrate_legacy_mapping(value: object, platform: str) -> object:
    """Upgrade stored mappings using the effective pre-2.0.5 platform behavior."""
    if not isinstance(value, dict) or not isinstance(value.get("columns"), list):
        return value
    enabled = value.get("replace_true_with_header", True) and platform == "logikcull"
    return {
        "columns": [
            {
                **column,
                "replace_true_with_header": (
                    column.get("replace_true_with_header", enabled)
                    if not isinstance(column.get("transform"), dict)
                    or column["transform"].get("kind") != "shorten_bates"
                    else False
                ),
            }
            if isinstance(column, dict)
            else column
            for column in value["columns"]
        ]
    }


class MappingBlankReport(BaseModel):
    blank_cells: list[int]
    output_rows: int


class WorkflowUpdate(BaseModel):
    workflow: JobWorkflow


class PleadingSettings(BaseModel):
    delimiter: Literal["comma", "semicolon", "pipe", "newline"] = "comma"
    include_and: bool = True
    request_sources: list[RequestSource] | None = None

    @model_validator(mode="after")
    def unique_request_sources(self) -> PleadingSettings:
        if self.request_sources is not None:
            columns = [source.column for source in self.request_sources]
            if len(columns) != len(set(columns)):
                raise ValueError("Select each request column only once")
        return self


class FinalizeRequest(BaseModel):
    output_filename: str = Field(min_length=1, max_length=124)
    acknowledged_issue_codes: list[str] = Field(default_factory=list)
    review_token: str = Field(min_length=32, max_length=256)


class ReviewRequest(BaseModel):
    acknowledged_issue_codes: list[str] = Field(default_factory=list)


class Preview(BaseModel):
    headers: list[str]
    rows: list[list[str]]
    total_rows: int
    skipped_rows: int
    formula_escapes: int
    artifact_sha256: str | None = None
    configuration_revision: int = 0
    sample_truncated: bool = False
    review_token: str | None = None
    text: str | None = None


class OutputStats(BaseModel):
    processing_ms: int
    input_rows: int
    output_rows: int
    output_columns: int
    output_cells: int
    output_size_bytes: int
    skipped_rows: int
    formula_escapes: int
    warnings_overridden: int


class ProcessingBuild(BaseModel):
    app_version: str
    build_id: str
    source_revision: str
    image_digest: str


class JobView(BaseModel):
    job_id: str
    created_at: str
    expires_at: str
    status: JobStatus
    progress: JobProgress
    workflow: JobWorkflow | None = None
    analysis: Analysis | None = None
    mapping: MappingConfig | None = None
    pleading_settings: PleadingSettings | None = None
    output_filename: str | None = None
    output_stats: OutputStats | None = None
    error: str | None = None
    error_code: str | None = None
    cancel_requested: bool = False
    revision: int = 0
    configuration_revision: int = 0
    reviewed_configuration_revision: int | None = None
    review_build: ProcessingBuild | None = None
    review_token: str | None = None
    staged_artifact_sha256: str | None = None
    staged_at: str | None = None
    input_sha256: str | None = None
    uploaded_at: str | None = None
    review_stats: OutputStats | None = None
    reviewed_issue_codes: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def upgrade_mapping(cls, value: object) -> object:
        if isinstance(value, dict) and isinstance(value.get("mapping"), dict):
            analysis = value.get("analysis")
            platform = analysis.get("platform", "unknown") if isinstance(analysis, dict) else "unknown"
            return {**value, "mapping": migrate_legacy_mapping(value["mapping"], platform)}
        return value


class JobCreated(BaseModel):
    job_id: str
    expires_at: str


class Capabilities(BaseModel):
    max_upload_bytes: int
    job_ttl_seconds: int
    max_active_jobs: int
    max_total_job_bytes: int
    max_mapping_columns: int = 100
    max_source_fields_per_column: int = 100
    supported_content_types: list[str]
    features: list[str]


class Receipt(BaseModel):
    schema_version: int = 3
    app_version: str
    build_id: str
    source_revision: str
    image_digest: str
    job_id: str
    created_at: str
    uploaded_at: str
    reviewed_at: str
    completed_at: str
    expires_at: str
    input_filename: str
    input_size_bytes: int
    input_sha256: str
    review_input_sha256: str
    output_filename: str
    output_size_bytes: int
    output_sha256: str
    staged_output_sha256: str
    configuration_revision: int
    workflow: JobWorkflow
    platform: Platform
    platform_confidence: int
    mapping: MappingConfig | None = None
    pleading_settings: PleadingSettings | None = None
    issue_counts: dict[str, int] = Field(default_factory=dict)
    acknowledged_issue_codes: list[str] = Field(default_factory=list)
    personal_data_counts: dict[str, int] = Field(default_factory=dict)
    output_stats: OutputStats
