/**
 * @file Keyboard and semantic tests for workflow selection.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import { WorkflowSelector } from "./workflow-selector";

describe("WorkflowSelector", () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  });

  it("exposes one radio group with roving tab stops", () => {
    render(<Providers><WorkflowSelector value="rfp_ranges" onChange={() => undefined} /></Providers>);

    expect(screen.getByRole("radiogroup", { name: "Output type" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /RFP \/ Pleading Ranges/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: /Privilege Log/ })).toHaveAttribute("tabindex", "-1");
  });

  it("selects the adjacent workflow with arrow keys", () => {
    const onChange = vi.fn();
    render(<Providers><WorkflowSelector value="rfp_ranges" onChange={onChange} /></Providers>);

    fireEvent.keyDown(screen.getByRole("radio", { name: /RFP \/ Pleading Ranges/ }), { key: "ArrowRight" });

    expect(onChange).toHaveBeenCalledWith("privilege_log");
  });
});
