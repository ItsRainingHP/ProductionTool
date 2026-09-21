/**
 * @file Interaction tests for privilege-log contact normalization controls.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import type { OutputColumn } from "../../lib/types";
import { MappingEditor } from "./mapping-editor";

describe("MappingEditor normalization", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  });

  it("reports the per-column normalize setting independently of the transform", () => {
    const onChange = vi.fn();
    const columns: OutputColumn[] = [{
      id: "author",
      name: "Author",
      source_fields: ["Author"],
      transform: { kind: "none", delimiter: null },
      normalize: false,
    }];
    render(
      <Providers>
        <MappingEditor headers={["Author"]} columns={columns} onChange={onChange} />
      </Providers>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Normalize names and emails" }));
    expect(onChange).toHaveBeenCalledWith([{ ...columns[0], normalize: true }]);
    expect(screen.getByText(/source CSV is not changed/i)).toBeInTheDocument();
  });
});
