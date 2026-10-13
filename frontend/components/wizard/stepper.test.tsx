import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import { Stepper } from "./stepper";

describe("wizard step navigation", () => {
  it("allows returning to completed steps while disabling future steps", () => {
    const onNavigate = vi.fn();
    render(<Providers><Stepper active="review" onNavigate={onNavigate} /></Providers>);
    fireEvent.click(screen.getByRole("button", { name: /Upload/ }));
    expect(onNavigate).toHaveBeenCalledWith("upload");
    expect(screen.getByRole("button", { name: /Download/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Review/ })).toHaveAttribute("aria-current", "step");
  });
});
