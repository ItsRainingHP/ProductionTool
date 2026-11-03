import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSourceDrag } from "./use-source-drag";

const dropped = vi.fn();
const active = vi.fn();
let capture = false;
let nextFrame: FrameRequestCallback | null;
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

function Harness({ callbacks = true }: { callbacks?: boolean }) {
  const { rootRef, previewRef, drag, overColumn, begin, consumeClick } = useSourceDrag(dropped, callbacks ? active : undefined);
  return <div ref={rootRef}>
    <button onPointerDown={(event) => begin(event, "Author")}
      onClick={(event) => { if (!consumeClick(event.detail)) dropped("selected"); }}>Source</button>
    <div data-mapping-column-id="people"><span>Drop here</span></div>
    <output>{overColumn}</output>
    {drag && <div ref={previewRef} data-testid="preview" style={{ width: drag.width }}>{drag.field}</div>}
  </div>;
}
const point = (x = 30, y = 40, extra: PointerEventInit = {}) => ({ clientX: x, clientY: y, ...extra });
function down() { fireEvent.pointerDown(screen.getByRole("button", { name: "Source" }), point()); }
function move(x = 130, y = 140) { fireEvent.pointerMove(window, point(x, y)); act(() => nextFrame?.(0)); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  capture = false;
  nextFrame = null;
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { nextFrame = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 20, top: 30, width: 200, height: 50 } as DOMRect);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => null) });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn(() => { capture = true; }) });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: vi.fn(() => capture) });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn(() => { capture = false; }) });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("source drag gesture", () => {
  it("shows press feedback immediately without treating a stationary release as a drop", () => {
    render(<Harness />);
    vi.mocked(document.elementFromPoint).mockReturnValue(screen.getByText("Drop here"));
    down();
    expect(screen.getByTestId("preview")).toHaveTextContent("Author");
    fireEvent.pointerUp(window, point());
    expect(dropped).not.toHaveBeenCalled();
    expect(screen.queryByTestId("preview")).toBeNull();
    expect(active).toHaveBeenLastCalledWith(false);
    down(); fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("preview")).toBeNull();
    expect(dropped).not.toHaveBeenCalled();
  });
  it("keeps sub-threshold presses as clicks and ignores non-mouse, secondary and non-primary presses", () => {
    render(<Harness />);
    const button = screen.getByRole("button");
    for (const extra of [{ pointerType: "touch" }, { button: 2 }, { isPrimary: false }]) {
      fireEvent.pointerDown(button, point(30, 40, extra)); move();
      expect(screen.queryByTestId("preview")).toBeNull();
    }
    down();
    expect(screen.getByTestId("preview")).toHaveStyle({ transform: "translate3d(20px, 30px, 0)" });
    expect(active).toHaveBeenCalledWith(true);
    fireEvent.pointerDown(button, point()); move(33, 44);
    expect(screen.getByTestId("preview")).toHaveStyle({ transform: "translate3d(23px, 34px, 0)" });
    fireEvent.pointerUp(window, point());
    fireEvent.click(button, { detail: 1 });
    expect(dropped).toHaveBeenCalledWith("selected");
  });

  it("follows the grab offset, finds nested targets and drops exactly once without selecting", () => {
    render(<Harness />);
    vi.mocked(document.elementFromPoint).mockReturnValue(screen.getByText("Drop here"));
    down(); move();
    const preview = screen.getByTestId("preview");
    expect(preview.style.transform).toBe("translate3d(120px, 130px, 0)");
    expect(screen.getByRole("status")).toHaveTextContent("people");
    expect(active).toHaveBeenCalledWith(true);
    move(230, 240);
    act(() => nextFrame?.(0));
    expect(preview.style.transform).toBe("translate3d(220px, 230px, 0)");
    fireEvent.pointerUp(window, point(230, 240));
    fireEvent.click(screen.getByRole("button"), { detail: 1 });
    expect(dropped.mock.calls).toEqual([["people", "Author"]]);
    expect(active).toHaveBeenLastCalledWith(false);
    expect(capture).toBe(false);
    expect(screen.queryByTestId("preview")).toBeNull();
    act(() => vi.runAllTimers());
    fireEvent.click(screen.getByRole("button"), { detail: 1 });
    expect(dropped).toHaveBeenLastCalledWith("selected");
  });

  it("supports callbacks being absent, viewport clamping, and rechecks hover after scrolling", () => {
    const view = render(<Harness callbacks={false} />);
    Object.defineProperty(screen.getByRole("button"), "getBoundingClientRect", { value: () => ({ left: -100, top: 0, width: 3000 }) });
    down(); move(-100, -100);
    expect(screen.getByTestId("preview").style.transform).toBe("translate3d(8px, 8px, 0)");
    move(3000, 3000); act(() => nextFrame?.(0));
    expect(screen.getByTestId("preview").style.transform).toContain("translate3d(8px,");
    vi.mocked(document.elementFromPoint).mockReturnValue(screen.getByText("Drop here"));
    fireEvent.scroll(window); act(() => nextFrame?.(0));
    expect(screen.getByRole("status")).toHaveTextContent("people");
    view.unmount();
    expect(capture).toBe(false);
  });

  it.each(["escape", "pointercancel", "lostpointercapture", "blur", "resize"])("cancels on %s without changing the mapping", (reason) => {
    render(<Harness />); down(); move();
    fireEvent.keyDown(window, { key: "a" });
    if (reason === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (reason === "pointercancel" || reason === "lostpointercapture") fireEvent(window, new TestPointerEvent(reason));
    else fireEvent(window, new Event(reason));
    fireEvent.pointerUp(window, point());
    expect(screen.queryByTestId("preview")).toBeNull();
    expect(dropped).not.toHaveBeenCalled();
    down(); fireEvent.pointerUp(window, point()); fireEvent.click(screen.getByRole("button"), { detail: 1 });
    expect(dropped).toHaveBeenCalledWith("selected");
  });

  it("ignores foreign pointers and targets outside this editor, and releases a non-drag press", () => {
    render(<Harness />);
    move(); down();
    fireEvent.pointerMove(window, point(130, 140, { pointerId: 2 }));
    fireEvent.pointerUp(window, point(130, 140, { pointerId: 2 }));
    fireEvent.pointerCancel(window, { pointerId: 2 });
    expect(screen.getByTestId("preview")).toHaveStyle({ transform: "translate3d(20px, 30px, 0)" });
    move();
    const outside = document.createElement("div"); outside.dataset.mappingColumnId = "other";
    vi.mocked(document.elementFromPoint).mockReturnValue(outside);
    fireEvent.pointerUp(window, point());
    expect(dropped).not.toHaveBeenCalled();
    down(); fireEvent.pointerUp(window, point());
    fireEvent.scroll(window); act(() => nextFrame?.(0));
    fireEvent.click(screen.getByRole("button"));
    expect(dropped).toHaveBeenCalledWith("selected");
  });
});
