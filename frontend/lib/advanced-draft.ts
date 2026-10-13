/** Tab-scoped Advanced-step configuration drafts; never store CSV rows or output. */
import type { Job, OutputColumn, PleadingSettings } from "./types";

const PREFIX = "production-tool.advanced-draft.v1.";

export interface AdvancedDraft {
  schemaVersion: 1;
  jobId: string;
  configurationRevision: number;
  expiresAt: string;
  acknowledged: string[];
  mappingColumns: OutputColumn[];
  pleadingSettings: PleadingSettings;
}

export function clearAdvancedDraft(jobId: string): void {
  try { window.sessionStorage.removeItem(PREFIX + jobId); } catch { /* storage may be disabled */ }
}

export function saveAdvancedDraft(draft: AdvancedDraft): boolean {
  try {
    window.sessionStorage.setItem(PREFIX + draft.jobId, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function loadAdvancedDraft(job: Job): { status: "none" | "restored" | "stale" | "unavailable"; draft?: AdvancedDraft } {
  let raw: string | null;
  try { raw = window.sessionStorage.getItem(PREFIX + job.job_id); }
  catch { return { status: "unavailable" }; }
  if (!raw) return { status: "none" };
  try {
    const draft = JSON.parse(raw) as AdvancedDraft;
    const valid = draft?.schemaVersion === 1
      && draft.jobId === job.job_id
      && Number.isInteger(draft.configurationRevision)
      && typeof draft.expiresAt === "string"
      && Array.isArray(draft.acknowledged)
      && draft.acknowledged.every((code) => typeof code === "string")
      && Array.isArray(draft.mappingColumns)
      && draft.mappingColumns.every((column) => column && typeof column.id === "string"
        && typeof column.name === "string" && Array.isArray(column.source_fields)
        && column.source_fields.every((field) => typeof field === "string")
        && column.transform && typeof column.transform.kind === "string")
      && draft.pleadingSettings
      && ["comma", "semicolon", "pipe", "newline"].includes(draft.pleadingSettings.delimiter)
      && typeof draft.pleadingSettings.include_and === "boolean";
    if (valid && draft.configurationRevision === job.configuration_revision
      && draft.expiresAt === job.expires_at && Date.parse(draft.expiresAt) > Date.now()
      && job.status === "needs_configuration") {
      return { status: "restored", draft };
    }
  } catch { /* corrupt or obsolete draft */ }
  clearAdvancedDraft(job.job_id);
  return { status: "stale" };
}
