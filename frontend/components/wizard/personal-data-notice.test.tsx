/**
 * @file Rendering tests for aggregate personal-data advisories.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import { PersonalDataNotice } from "./personal-data-notice";

describe("PersonalDataNotice", () => {
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

  it("shows aggregate advisory details without sensitive values", () => {
    render(
      <Providers>
        <PersonalDataNotice findings={[
          { category: "personal_email", count: 2, columns: ["From", "To"] },
          { category: "single_word_name", count: 1, columns: ["Author"] },
        ]} />
      </Providers>,
    );

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Potential personal data detected");
    expect(notice).toHaveTextContent("Personal email domains");
    expect(notice).toHaveTextContent("Columns: From, To");
    expect(notice).toHaveTextContent("Possible one-word names or usernames");
    expect(notice).toHaveTextContent("does not change the source CSV or prevent you from continuing");
    expect(notice).not.toHaveTextContent("gmail.com");
  });

  it("renders nothing when no findings exist", () => {
    const { container } = render(<Providers><PersonalDataNotice findings={[]} /></Providers>);
    expect(container).toBeEmptyDOMElement();
  });
});
