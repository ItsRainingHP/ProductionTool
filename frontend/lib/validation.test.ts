/**
 * @file Unit tests for upload validation and derived issue state.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { describe, expect, it } from "vitest";
import type { Analysis, Issue } from "./types";
import { clientFileError, issueOccurrenceCount, validationTone, warningsAcknowledged } from "./validation";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    code: "blank_begin_bates",
    severity: "warning",
    message: "A Bates value is blank.",
    overrideable: true,
    row: 4,
    column: "Begin Bates",
    count: 1,
    ...overrides,
  };
}

function analysis(issues: Issue[]): Analysis {
  return {
    filename: "production.csv",
    size_bytes: 100,
    row_count: 2,
    column_count: 3,
    headers: ["Begin Bates", "End Bates", "RFP"],
    platform: "unknown",
    platform_confidence: 0,
    detected_workflow: "rfp_ranges",
    rfp_layout: "combined",
    begin_bates_header: "Begin Bates",
    end_bates_header: "End Bates",
    prefixes: ["TEST_"],
    request_count: 1,
    duplicate_ranges: 0,
    gap_count: 0,
    issues,
    personal_data_findings: [],
  };
}

describe("CSV validation state", () => {
  it("derives green, yellow, and red states", () => {
    expect(validationTone(analysis([]))).toBe("valid");
    expect(validationTone(analysis([issue()]))).toBe("warning");
    expect(validationTone(analysis([issue({ severity: "error", overrideable: false })]))).toBe("blocked");
    expect(validationTone(analysis([issue(), issue({ severity: "fatal", overrideable: false })]))).toBe("blocked");
  });

  it("requires every warning code and counts affected occurrences", () => {
    const value = analysis([issue({ count: 3 }), issue({ code: "blank_end_bates", count: 2 })]);
    expect(issueOccurrenceCount(value.issues)).toBe(5);
    expect(warningsAcknowledged(value, ["blank_begin_bates"])).toBe(false);
    expect(warningsAcknowledged(value, ["blank_begin_bates", "blank_end_bates"])).toBe(true);
  });

  it("keeps personal-data findings advisory", () => {
    const value = analysis([]);
    value.personal_data_findings = [{ category: "single_word_name", count: 1, columns: ["Author"] }];
    expect(validationTone(value)).toBe("valid");
    expect(warningsAcknowledged(value, [])).toBe(true);
  });
});

describe("client CSV checks", () => {
  const maxBytes = 500 * 1024 * 1024;

  it("accepts supported CSV declarations case-insensitively", () => {
    expect(clientFileError({ name: "EXPORT.CSV", size: 10, type: "text/csv" }, maxBytes)).toBeNull();
    expect(clientFileError({ name: "export.csv", size: 10, type: "" }, maxBytes)).toBeNull();
  });

  it("rejects wrong extensions, empty, oversized, and incompatible declared types", () => {
    expect(clientFileError({ name: "export.txt", size: 10, type: "text/plain" }, maxBytes)).toMatch(/\.csv/);
    expect(clientFileError({ name: "export.csv", size: 0, type: "text/csv" }, maxBytes)).toMatch(/non-empty/);
    expect(clientFileError({ name: "export.csv", size: maxBytes + 1, type: "text/csv" }, maxBytes)).toMatch(/500 MB/);
    expect(clientFileError({ name: "export.csv", size: 10, type: "application/pdf" }, maxBytes)).toMatch(/unsupported type/);
  });
});
