import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Job } from "./types";
import { clearAdvancedDraft, loadAdvancedDraft, saveAdvancedDraft } from "./advanced-draft";

const job = {
  job_id: "job-1", configuration_revision: 3, expires_at: "2099-01-01T00:00:00Z",
  status: "needs_configuration",
} as Job;

const draft = {
  schemaVersion: 1 as const, jobId: job.job_id, configurationRevision: job.configuration_revision,
  expiresAt: job.expires_at, acknowledged: ["uneven_row_width"], mappingColumns: [],
  pleadingSettings: { delimiter: "semicolon" as const, include_and: false },
};

beforeEach(() => window.sessionStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("restores only a matching live job configuration in this tab", () => {
  const populated = { ...draft, mappingColumns: [{
    id: "author", name: "Author", source_fields: ["From"],
    transform: { kind: "none" as const, delimiter: null }, normalize: false,
  }] };
  expect(saveAdvancedDraft(populated)).toBe(true);
  expect(loadAdvancedDraft(job)).toEqual({ status: "restored", draft: populated });
  expect(loadAdvancedDraft({ ...job, configuration_revision: 4 })).toEqual({ status: "stale" });
  expect(loadAdvancedDraft(job)).toEqual({ status: "none" });
  expect(saveAdvancedDraft(draft)).toBe(true);
  clearAdvancedDraft(job.job_id);
  expect(loadAdvancedDraft(job)).toEqual({ status: "none" });
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
