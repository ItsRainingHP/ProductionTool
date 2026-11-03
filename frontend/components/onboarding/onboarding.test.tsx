import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/app/providers";
import { ONBOARDING_KEY, freshOnboarding, type TourScreen } from "@/lib/onboarding";
import { OnboardingProvider, TourHelp, useTourScreen } from "./onboarding";
import type { TourRunnerProps } from "./tour-runner";

const runner = vi.hoisted(() => ({ props: null as TourRunnerProps | null }));
vi.mock("next/dynamic", () => ({ default: () => function Runner(props: TourRunnerProps) {
  runner.props = props;
  return <div data-testid="tour-runner">{props.chapter}:{props.initialIndex}
    <button onClick={() => props.onProgress(props.tips[1].id)}>Read second tip</button>
    <button onClick={props.onPause}>Pause mock tour</button><button onClick={props.onFinish}>Finish mock tour</button>
  </div>;
} }));

function Registered({ info }: { info: TourScreen }) {
  useTourScreen(info);
  return <main><input aria-label="Working field" /><button>Workspace action</button></main>;
}
function view(info?: TourScreen) {
  return <Providers><OnboardingProvider><TourHelp />{info && <Registered info={info} />}</OnboardingProvider></Providers>;
}
const upload: TourScreen = { chapter: "upload", ready: true, maxUpload: "500 MiB", retentionHours: 4 };
const stored = () => JSON.parse(window.localStorage.getItem(ONBOARDING_KEY) ?? "{}");

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  } });
  window.sessionStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  runner.props = null;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("first-use introductions", () => {
  it("waits for a production screen before offering the tour and remembers Skip across mounts", async () => {
    const first = render(view());
    await waitFor(() => expect(window.localStorage.getItem).toHaveBeenCalledWith(ONBOARDING_KEY));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    first.rerender(view(upload));
    expect(await screen.findByRole("button", { name: "Start tour" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(stored().preference).toBe("skipped");
    first.unmount(); render(view(upload));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume tour" }));
    expect(await screen.findByTestId("tour-runner")).toHaveTextContent("upload:0");
  });

  it("starts on the current screen and persists pause/resume at the current tip", async () => {
    const first = render(view(upload));
    fireEvent.click(await screen.findByRole("button", { name: "Start tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Read second tip" }));
    fireEvent.click(screen.getByRole("button", { name: "Read second tip" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause mock tour" }));
    expect(stored().preference).toBe("paused");
    first.unmount(); render(view(upload));
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume tour" }));
    expect(await screen.findByTestId("tour-runner")).toHaveTextContent("upload:1");
    fireEvent.click(screen.getByRole("button", { name: "Finish mock tour" }));
    expect(stored().chapters.upload).toEqual({ completed: true, nextTipId: null });
  });

  it("automatically introduces unseen screens and tracks both Advanced paths", async () => {
    window.localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ ...freshOnboarding(), preference: "enabled" }));
    const current = render(view(upload));
    fireEvent.click(await screen.findByRole("button", { name: "Finish mock tour" }));
    current.rerender(view({ chapter: "advanced-rfp", ready: true }));
    expect(await screen.findByTestId("tour-runner")).toHaveTextContent("advanced-rfp");
    fireEvent.click(screen.getByRole("button", { name: "Finish mock tour" }));
    current.rerender(view({ chapter: "advanced-privilege", ready: true }));
    expect(await screen.findByTestId("tour-runner")).toHaveTextContent("advanced-privilege");
    fireEvent.click(screen.getByRole("button", { name: "Finish mock tour" }));
    expect(Object.keys(stored().chapters)).toEqual(["upload", "advanced-rfp", "advanced-privilege"]);
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue tour" }));
    expect(screen.queryByTestId("tour-runner")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replay this screen" }));
    expect(await screen.findByTestId("tour-runner")).toHaveTextContent("advanced-privilege:0");
  });

  it("offers both optional guides without modifying the screen", async () => {
    window.localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ ...freshOnboarding(), preference: "paused" }));
    const current = render(view({ chapter: "advanced-privilege", ready: true }));
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Explain mapping options" }));
    expect(await screen.findByTestId("tour-runner")).toHaveTextContent("mapping-details");
    fireEvent.click(screen.getByRole("button", { name: "Finish mock tour" }));
    current.rerender(view({ chapter: "advanced-rfp", ready: true }));
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Explain text formatting" }));
    expect(await screen.findByTestId("tour-runner")).toHaveTextContent("format-details");
    current.rerender(view({ chapter: "review", ready: false }));
    await waitFor(() => expect(screen.queryByTestId("tour-runner")).not.toBeInTheDocument());
  });

  it("defers automatic guidance during loading, draft editing, and focused input", async () => {
    window.localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ ...freshOnboarding(), preference: "enabled" }));
    const current = render(view({ ...upload, ready: false }));
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    expect(await screen.findByRole("button", { name: "Replay this screen" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    current.rerender(view({ ...upload, deferAutomatic: true }));
    expect(screen.queryByTestId("tour-runner")).not.toBeInTheDocument();
    act(() => screen.getByRole("textbox").focus());
    current.rerender(view(upload));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByTestId("tour-runner")).not.toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Workspace action" }).focus());
    expect(await screen.findByTestId("tour-runner")).toBeInTheDocument();
  });

  it("synchronizes external dismissal while retaining completed sections", async () => {
    window.localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ ...freshOnboarding(), preference: "enabled", chapters: { upload: { completed: true, nextTipId: null } } }));
    render(view({ chapter: "data", ready: true }));
    await screen.findByTestId("tour-runner");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "{}" }));
      window.dispatchEvent(new StorageEvent("storage", { key: ONBOARDING_KEY, newValue: "broken" }));
      window.dispatchEvent(new StorageEvent("storage", { key: ONBOARDING_KEY, newValue: JSON.stringify({ ...freshOnboarding(), preference: "paused" }) }));
    });
    expect(screen.queryByTestId("tour-runner")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume tour" }));
    expect(stored().chapters.upload.completed).toBe(true);
  });

  it("describes storage fallback in production Help", async () => {
    vi.mocked(window.localStorage.getItem).mockImplementation((key) => { if (key === ONBOARDING_KEY) throw new Error("denied"); return null; });
    vi.mocked(window.localStorage.setItem).mockImplementation(() => { throw new Error("denied"); });
    render(view(upload));
    fireEvent.click(await screen.findByRole("button", { name: "Skip tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    expect(await screen.findByText(/in this tab for this browser session/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume tour" })).toBeVisible();
  });

  it("handles drag deferral, welcome dismissal, and absent provider", async () => {
    const current = render(view(upload));
    fireEvent.dragStart(screen.getByRole("button", { name: "Workspace action" }));
    fireEvent.dragEnd(screen.getByRole("button", { name: "Workspace action" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(stored().preference).toBe("skipped");
    current.unmount();
    render(<><TourHelp /><Registered info={upload} /></>);
    expect(screen.queryByRole("button", { name: "Help and guided tour" })).not.toBeInTheDocument();
  });

  it("continues in memory when both browser stores reject tour state", async () => {
    vi.mocked(window.localStorage.getItem).mockImplementation((key) => { if (key === ONBOARDING_KEY) throw new Error("denied"); return null; });
    vi.mocked(window.localStorage.setItem).mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(view(upload));
    fireEvent.click(await screen.findByRole("button", { name: "Skip tour" }));
    fireEvent.click(screen.getByRole("button", { name: "Help and guided tour" }));
    expect(await screen.findByText(/until this page is reloaded/)).toBeInTheDocument();
  });
});
