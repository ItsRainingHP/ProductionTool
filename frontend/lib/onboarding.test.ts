import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAPTERS, ONBOARDING_KEY, freshOnboarding, parseOnboarding, readOnboarding, tourTips, writeOnboarding } from "./onboarding";

function storage() {
  const values = new Map<string, string>();
  return { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }) };
}
let local: ReturnType<typeof storage>;
let session: ReturnType<typeof storage>;
beforeEach(() => {
  local = storage(); session = storage();
  Object.defineProperty(window, "localStorage", { configurable: true, value: local });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: session });
});

describe("browser-local onboarding persistence", () => {
  it.each([null, "{", "x".repeat(16385), "null", "{}", '{"schemaVersion":2}',
    JSON.stringify({ schemaVersion: 1, preference: "invalid", chapters: {} }),
    JSON.stringify({ schemaVersion: 1, preference: "new", chapters: [] }),
    JSON.stringify({ ...freshOnboarding(), chapters: { upload: { completed: "yes", nextTipId: null } } }),
    JSON.stringify({ ...freshOnboarding(), chapters: { upload: { completed: false, nextTipId: "file.csv" } } }),
  ])("rejects invalid or obsolete state without throwing: %s", (raw) => {
    expect(parseOnboarding(raw)).toBeNull();
  });

  it("whitelists fields and chapter identifiers", () => {
    const state = { ...freshOnboarding(), chapters: { upload: { completed: false, nextTipId: "upload-csv", filename: "private.csv" }, unknown: { completed: true } }, jobId: "private" };
    expect(parseOnboarding(JSON.stringify(state))).toEqual({ ...freshOnboarding(), chapters: { upload: { completed: false, nextTipId: "upload-csv" } } });
  });

  it("reads and saves local progress, clearing an older session fallback", () => {
    expect(readOnboarding()).toEqual({ state: freshOnboarding(), persistence: "local" });
    const state = { ...freshOnboarding(), preference: "enabled" as const, chapters: { data: { completed: true, nextTipId: null } } };
    session.setItem(ONBOARDING_KEY, JSON.stringify(freshOnboarding()));
    expect(writeOnboarding(state)).toBe("local");
    expect(session.getItem(ONBOARDING_KEY)).toBeNull();
    expect(readOnboarding().state).toEqual(state);
  });

  it("uses the newer session fallback when local writes fail", () => {
    local.setItem(ONBOARDING_KEY, JSON.stringify(freshOnboarding()));
    local.setItem.mockImplementation(() => { throw new Error("quota"); });
    const paused = { ...freshOnboarding(), preference: "paused" as const };
    expect(writeOnboarding(paused)).toBe("session");
    expect(readOnboarding()).toEqual({ state: paused, persistence: "session" });
  });

  it("handles read-denied, fully unavailable, corrupt, and cleanup-denied storage", () => {
    local.getItem.mockImplementation(() => { throw new Error("denied"); });
    expect(readOnboarding().persistence).toBe("session");
    session.getItem.mockImplementation(() => { throw new Error("denied"); });
    expect(readOnboarding()).toEqual({ state: freshOnboarding(), persistence: "memory" });
    local.setItem.mockImplementation(() => { throw new Error("denied"); });
    session.setItem.mockImplementation(() => { throw new Error("denied"); });
    expect(writeOnboarding(freshOnboarding())).toBe("memory");
    local.setItem.mockImplementation(() => undefined);
    session.removeItem.mockImplementation(() => { throw new Error("denied"); });
    expect(writeOnboarding(freshOnboarding())).toBe("local");
  });
});

describe("tour copy and conditional chapters", () => {
  it.each(CHAPTERS)("supplies stable, unique tips for %s", (chapter) => {
    const tips = tourTips(chapter, { chapter: "upload", ready: true, maxUpload: "500 MiB", retentionHours: 4 });
    expect(tips.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tips.map((tip) => tip.id)).size).toBe(tips.length);
    expect(tips.every((tip) => tip.content && tip.title && tip.target.includes(tip.id))).toBe(true);
  });
  it("adds advisories and replaces output selection for blocked files", () => {
    const tips = tourTips("data", { chapter: "data", ready: true, blocked: true, advisories: true });
    expect(tips.map((tip) => tip.id)).toEqual(["analysis-summary", "validation", "personal-data", "replace-csv"]);
    expect(tips[1].content).toContain("blocking problems");
    expect(tourTips("review", { chapter: "review", ready: true, isTextOutput: true })[1].content).toContain("5,000 characters");
  });
});
