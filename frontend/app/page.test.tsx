import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Home from "./page";
import WizardPage from "./wizard/[[...segments]]/page";
import { Providers } from "./providers";

vi.mock("@/components/wizard/wizard", () => ({ Wizard: () => <div>Resumable wizard</div> }));

describe("application pages", () => {
  it("explains both outputs and links to the processing wizard", () => {
    render(<Providers><Home /></Providers>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("discovery exports");
    expect(screen.getByRole("heading", { name: "RFP ranges" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Privilege mapping" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start Processing" })).toHaveAttribute("href", "/wizard");
    expect(screen.getByRole("link", { name: "Visit the Once UI website" })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders the resumable wizard route", () => {
    render(<WizardPage />);
    expect(screen.getByText("Resumable wizard")).toBeInTheDocument();
  });
});
