import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/app/providers";
import { AppFooter } from "./app-footer";
import { SystemStatus } from "./system-status";

const payload = (update_available = false) => new Response(JSON.stringify({
  current_version: "2.0.5", latest_version: update_available ? "2.0.6" : "2.0.5", update_available,
}));
const view = (key = "home") => <Providers><AppFooter key={key} /></Providers>;

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("footer Systems Status", () => {
  it("uses native hover text without rendering a persistent status label after focus or click", () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => {})));
    render(<Providers><SystemStatus /></Providers>);
    const indicator = screen.getByRole("img", { name: "Systems Status: ready" });
    expect(indicator).toHaveAttribute("data-status", "ready");
    expect(indicator).toHaveAttribute("tabindex", "0");
    expect(indicator).toHaveAttribute("title", "ready");
    expect(screen.queryByText(/^ready$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseEnter(indicator);
    fireEvent.focus(indicator);
    fireEvent.click(indicator);
    fireEvent.mouseLeave(indicator);
    expect(screen.queryByText(/^ready$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.blur(indicator);
    expect(screen.queryByText(/^ready$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("puts status below the version and retains a confirmed update across page navigation", async () => {
    const fetch = vi.fn().mockResolvedValue(payload(true));
    vi.stubGlobal("fetch", fetch);
    let rendered: ReturnType<typeof render>;
    await act(async () => { rendered = render(view()); });
    const version = screen.getByText(/^Version /);
    expect(version.parentElement?.lastElementChild).toHaveTextContent("Systems Status");
    const indicator = screen.getByRole("img", { name: "Systems Status: update available" });
    expect(indicator).toHaveAttribute("data-status", "update-available");
    expect(indicator).toHaveAttribute("title", "update available");
    fireEvent.focus(indicator);
    fireEvent.click(indicator);
    expect(screen.queryByText(/^update available$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    rendered!.rerender(view("wizard"));
    expect(screen.getByRole("img", { name: "Systems Status: update available" })).toHaveAttribute("title", "update available");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/v1/system-status", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("preserves yellow on failed or malformed polls and clears it after a successful current-version result", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(payload(true)).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response('{"update_available":"false"}'))
      .mockResolvedValueOnce(payload());
    vi.stubGlobal("fetch", fetch);
    await act(async () => { render(view()); });
    for (let poll = 0; poll < 3; poll++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      expect(screen.getByRole("img", { name: "Systems Status: update available" })).toBeInTheDocument();
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(screen.getByRole("img", { name: "Systems Status: ready" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("keeps green on initial failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await act(async () => { render(view()); });
    expect(screen.getByRole("img", { name: "Systems Status: ready" })).toBeInTheDocument();
  });

  it("skips hidden tabs and overlapping polls, checks when visible, and aborts on unmount", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    let resolve: (response: Response) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetch);
    const rendered = render(view());
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(fetch).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    rendered.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve!(payload(true)); });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
