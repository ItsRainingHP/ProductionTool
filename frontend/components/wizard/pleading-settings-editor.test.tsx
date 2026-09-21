/**
 * @file Interaction tests for pleading delimiter and conjunction settings.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import { DEFAULT_PLEADING_SETTINGS, PleadingSettingsEditor } from "./pleading-settings-editor";

describe("PleadingSettingsEditor", () => {
  afterEach(cleanup);

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

  it("shows comma and the conjunction as defaults", () => {
    render(<Providers><PleadingSettingsEditor settings={DEFAULT_PLEADING_SETTINGS} onChange={() => undefined} /></Providers>);

    expect(screen.getByRole("button", { name: "Comma" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "Include ‘and’ before the final range" })).toBeChecked();
  });

  it("reports delimiter and conjunction changes", () => {
    const onChange = vi.fn();
    render(<Providers><PleadingSettingsEditor settings={DEFAULT_PLEADING_SETTINGS} onChange={onChange} /></Providers>);

    fireEvent.click(screen.getByRole("button", { name: "Semicolon" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include ‘and’ before the final range" }));

    expect(onChange).toHaveBeenNthCalledWith(1, { delimiter: "semicolon", include_and: true });
    expect(onChange).toHaveBeenNthCalledWith(2, { delimiter: "comma", include_and: false });
  });
});
