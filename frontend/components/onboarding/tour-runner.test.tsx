import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIONS, EVENTS, STATUS, type Controls, type EventData, type Props, type TooltipRenderProps } from "react-joyride";
import TourRunner from "./tour-runner";
import { tourTips } from "@/lib/onboarding";

const captured = vi.hoisted(() => ({ props: null as Props | null }));
vi.mock("react-joyride", async (original) => ({ ...await original<typeof import("react-joyride")>(),
  Joyride: (props: Props) => { captured.props = props; return <div data-testid="joyride" />; },
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("tour overlay adapter", () => {
  it("reports progress, completion, dismissal, and failed targets and restores inert surfaces", () => {
    const onProgress = vi.fn(); const onFinish = vi.fn(); const onPause = vi.fn();
    const view = render(<><header className="app-header" inert /><main>Work</main><footer className="app-footer" />
      <TourRunner chapter="upload" tips={tourTips("upload", { chapter: "upload", ready: true })} initialIndex={0}
        onProgress={onProgress} onFinish={onFinish} onPause={onPause} /></>);
    expect(document.querySelector("main")?.inert).toBe(true);
    const emit = (data: Partial<EventData>) => act(() => captured.props!.onEvent!({ action: ACTIONS.NEXT, ...data } as EventData, {} as Controls));
    emit({ type: EVENTS.TOOLTIP, step: { data: { id: "upload-csv" } } as EventData["step"] });
    expect(onProgress).toHaveBeenCalledWith("upload-csv");
    emit({ action: ACTIONS.CLOSE }); emit({ action: ACTIONS.SKIP });
    emit({ type: EVENTS.TARGET_NOT_FOUND }); emit({ type: EVENTS.ERROR });
    expect(onPause).toHaveBeenCalledTimes(4);
    fireEvent.keyDown(document, { key: "Tab" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onPause).toHaveBeenCalledTimes(5);
    emit({ type: EVENTS.TOUR_END, status: STATUS.FINISHED });
    emit({ type: EVENTS.TOUR_END, status: STATUS.RUNNING });
    expect(onFinish).toHaveBeenCalledOnce();
    view.unmount();
    // These elements survive the tour unmount in the real app.
    const main = document.createElement("main"); main.inert = false; document.body.append(main);
    const second = render(<TourRunner chapter="upload" tips={[]} initialIndex={0} onProgress={onProgress} onFinish={onFinish} onPause={onPause} />);
    second.unmount(); expect(main.inert).toBe(false); main.remove();
  });

  it("renders accessible Once UI controls with separate tip progress", () => {
    render(<TourRunner chapter="review" tips={tourTips("review", { chapter: "review", ready: true })} initialIndex={0}
      onProgress={vi.fn()} onFinish={vi.fn()} onPause={vi.fn()} />);
    const click = vi.fn();
    const button = { onClick: click, "aria-label": "Action", "data-action": "next", role: "button", title: "Action" };
    const props = { backProps: button, closeProps: button, primaryProps: button, skipProps: button,
      tooltipProps: { role: "dialog", "aria-modal": true }, index: 0, size: 3, isLastStep: false,
      step: { title: "Review sample", content: "Read this sample first.", data: { label: "Review" } } } as unknown as TooltipRenderProps;
    const Tooltip = captured.props!.tooltipComponent!;
    const view = render(createElement(Tooltip, props));
    expect(screen.getByRole("dialog", { name: "Review sample" })).toHaveAttribute("aria-describedby", "tour-description");
    expect(screen.getByText("Review · Tip 1 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next tip" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause and close tour" }));
    expect(click).toHaveBeenCalledTimes(3);
    view.rerender(createElement(Tooltip, { ...props, index: 2, isLastStep: true }));
    expect(screen.getByRole("button", { name: "Got it" })).toBeInTheDocument();
    expect(screen.getByText("Review · Tip 3 of 3")).toBeInTheDocument();
  });

  it("disables scroll animation for reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    render(<TourRunner chapter="upload" tips={[]} initialIndex={0} onProgress={vi.fn()} onFinish={vi.fn()} onPause={vi.fn()} />);
    expect(captured.props!.options?.scrollDuration).toBe(0);
    expect(captured.props!.options?.blockTargetInteraction).toBe(true);
  });

  it("restores the screen heading after library cleanup and respects another open dialog", async () => {
    const main = document.createElement("main"); main.inert = false;
    const heading = document.createElement("h1"); heading.id = "step-title"; heading.tabIndex = -1;
    main.append(heading); document.body.append(main);
    const props = { chapter: "upload" as const, tips: [], initialIndex: 0, onProgress: vi.fn(), onFinish: vi.fn(), onPause: vi.fn() };
    const first = render(<TourRunner {...props} />);
    first.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(heading);
    const second = render(<TourRunner {...props} />);
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
    second.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(main.inert).toBe(false);
    dialog.remove(); main.remove();
  });
});
