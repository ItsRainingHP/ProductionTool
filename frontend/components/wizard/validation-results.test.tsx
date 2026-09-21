/**
 * @file Interaction tests for validation states and warning acknowledgements.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import type { Analysis } from "../../lib/types";
import { ValidationResults } from "./validation-results";

const analysis: Analysis = {
  filename: "warning.csv",
  size_bytes: 100,
  row_count: 2,
  column_count: 2,
  headers: ["Begin Bates", "End Bates"],
  platform: "unknown",
  platform_confidence: 0,
  detected_workflow: "privilege_log",
  rfp_layout: null,
  begin_bates_header: "Begin Bates",
  end_bates_header: "End Bates",
  prefixes: [],
  request_count: 0,
  duplicate_ranges: 0,
  gap_count: 0,
  issues: [{
    code: "blank_begin_bates",
    severity: "warning",
    message: "One or more rows have a blank Begin Bates value.",
    overrideable: true,
    row: 2,
    column: "Begin Bates",
    count: 2,
  }],
  personal_data_findings: [],
};

describe("ValidationResults", () => {
  it("shows accessible warning detail and acknowledges the individual issue", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const onToggle = vi.fn();
    render(<Providers><ValidationResults analysis={analysis} acknowledged={[]} onToggle={onToggle} /></Providers>);

    expect(screen.getByRole("status")).toHaveTextContent("Review required");
    expect(screen.getByText(/First affected row: 2/)).toHaveTextContent("Column: Begin Bates");
    fireEvent.click(screen.getByRole("checkbox", { name: /understand how this issue affects/i }));
    expect(onToggle).toHaveBeenCalledWith("blank_begin_bates");
  });
});
