/**
 * @file Tests for the large-file upload progress display.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import { UploadProgress } from "./upload-progress";

describe("UploadProgress", () => {
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

  it("shows exact transfer progress during a large upload", () => {
    render(
      <Providers>
        <UploadProgress
          file={{ name: "large-production.csv", size: 500 * 1024 * 1024 }}
          stage="uploading"
          percent={42}
          transferredBytes={210 * 1024 * 1024}
          transferBytes={500 * 1024 * 1024}
          phase="Uploading CSV"
        />
      </Providers>,
    );

    expect(screen.getByRole("heading", { name: "Uploading CSV data" })).toBeInTheDocument();
    expect(screen.getByText("large-production.csv")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByRole("status")).toHaveTextContent("210.0 MB of 500.0 MB transferred");
  });

  it("explains that Step 2 opens after server analysis", () => {
    render(
      <Providers>
        <UploadProgress
          file={{ name: "large-production.csv", size: 500 * 1024 * 1024 }}
          stage="analyzing"
          percent={35}
          phase="Analyzing CSV"
        />
      </Providers>,
    );

    expect(screen.getByRole("heading", { name: "Analyzing CSV data" })).toBeInTheDocument();
    expect(screen.getByText(/Step 2 will open automatically/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Analyzing CSV");
  });
});
