import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Job } from "./types";
import { clearAdvancedDraft, loadAdvancedDraft, saveAdvancedDraft } from "./advanced-draft";

const job = {
  job_id: "job-1", configuration_revision: 3, expires_at: "2099-01-01T00:00:00Z",
  status: "needs_configuration",
} as Job;

const draft = {
  schemaVersion: 2 as const, jobId: job.job_id, configurationRevision: job.configuration_revision,
  expiresAt: job.expires_at, acknowledged: ["uneven_row_width"], mappingColumns: [],
  pleadingSettings: { delimiter: "semicolon" as const, include_and: false },
};

beforeEach(() => window.sessionStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("restores request layouts and input separators, rejecting unknown source columns", () => {
  const sourceJob = { ...job, analysis: { headers: ["Begin", "End", "Matter"],
    begin_bates_header: "Begin", end_bates_header: "End" } } as Job;
  const configured = { ...draft, pleadingSettings: { ...draft.pleadingSettings,
    request_sources: [{ column: "Matter", layout: "category" as const, input_separator: "semicolon" as const }] } };
  saveAdvancedDraft(configured);
  expect(loadAdvancedDraft(sourceJob).draft?.pleadingSettings).toEqual(configured.pleadingSettings);
  saveAdvancedDraft({ ...configured, pleadingSettings: { ...configured.pleadingSettings,
    request_sources: [{ ...configured.pleadingSettings.request_sources[0], column: "Unknown" }] } });
  expect(loadAdvancedDraft(sourceJob).status).toBe("stale");
});

it("restores only a matching live job configuration in this tab", () => {
  const populated = { ...draft, mappingColumns: [{
    id: "author", name: "Author", source_fields: ["From"],
    transform: { kind: "none" as const, delimiter: null }, normalize: false, replace_true_with_header: false,
  }] };
  expect(saveAdvancedDraft(populated)).toBe(true);
  expect(loadAdvancedDraft(job)).toEqual({ status: "restored", draft: populated });
  expect(loadAdvancedDraft({ ...job, configuration_revision: 4 })).toEqual({ status: "stale" });
  expect(loadAdvancedDraft(job)).toEqual({ status: "none" });
  expect(saveAdvancedDraft(draft)).toBe(true);
  clearAdvancedDraft(job.job_id);
  expect(loadAdvancedDraft(job)).toEqual({ status: "none" });
});

it.each(["logikcull", "everlaw", "unknown"] as const)("migrates legacy drafts using the effective %s behavior", (platform) => {
  const legacy = { ...draft, schemaVersion: 1, mappingColumns: [
    { id: "flag", name: "Flag", source_fields: ["Flag"], transform: { kind: "none" }, normalize: false },
    { id: "range", name: "Range", source_fields: ["Begin", "End"], transform: { kind: "shorten_bates" }, normalize: false },
  ] };
  window.sessionStorage.setItem("production-tool.advanced-draft.v1.job-1", JSON.stringify(legacy));
  const restored = loadAdvancedDraft({ ...job, analysis: { platform } } as Job);
  expect(restored.draft?.schemaVersion).toBe(2);
  expect(restored.draft?.mappingColumns.map((column) => column.replace_true_with_header)).toEqual([platform === "logikcull", false]);
  expect(saveAdvancedDraft(restored.draft!)).toBe(true);
  expect(window.sessionStorage.getItem("production-tool.advanced-draft.v1.job-1")).toBeNull();
});

it("preserves a disabled legacy setting and rejects invalid settings", () => {
  window.sessionStorage.setItem("production-tool.advanced-draft.v1.job-1", JSON.stringify({
    ...draft, schemaVersion: 1, replaceTrueWithHeader: false,
    mappingColumns: [{ id: "flag", name: "Flag", source_fields: ["Flag"], transform: { kind: "none" } }],
  }));
  expect(loadAdvancedDraft({ ...job, analysis: { platform: "logikcull" } } as Job).draft?.mappingColumns[0].replace_true_with_header).toBe(false);
  window.sessionStorage.setItem("production-tool.advanced-draft.v1.job-1", JSON.stringify({
    ...draft, replaceTrueWithHeader: "false",
  }));
  expect(loadAdvancedDraft(job)).toEqual({ status: "stale" });
  window.sessionStorage.setItem("production-tool.advanced-draft.v2.job-1", JSON.stringify({ ...draft,
    mappingColumns: [{ id: "flag", name: "Flag", source_fields: ["Flag"], transform: { kind: "none" }, replace_true_with_header: "false" }],
  }));
  expect(loadAdvancedDraft(job)).toEqual({ status: "stale" });
});

it("clears expired and malformed drafts and reports unavailable storage", () => {
  expect(saveAdvancedDraft(draft)).toBe(true);
  expect(loadAdvancedDraft({ ...job, expires_at: "2000-01-01T00:00:00Z" })).toEqual({ status: "stale" });
  window.sessionStorage.setItem("production-tool.advanced-draft.v1.job-1", "not-json");
  expect(loadAdvancedDraft(job)).toEqual({ status: "stale" });
  vi.stubGlobal("sessionStorage", {
    setItem: () => { throw new Error("blocked"); },
    getItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  });
  expect(saveAdvancedDraft(draft)).toBe(false);
  expect(loadAdvancedDraft(job)).toEqual({ status: "unavailable" });
  expect(() => clearAdvancedDraft(job.job_id)).not.toThrow();
});
