/** Tab-scoped Advanced-step configuration drafts; never store CSV rows or output. */
import type { Job, OutputColumn, PleadingSettings } from "./types";

const PREFIX = "production-tool.advanced-draft.v2.";
const LEGACY_PREFIX = "production-tool.advanced-draft.v1.";

export interface AdvancedDraft {
  schemaVersion: 2;
  jobId: string;
  configurationRevision: number;
  expiresAt: string;
  acknowledged: string[];
  mappingColumns: OutputColumn[];
  pleadingSettings: PleadingSettings;
}

export function clearAdvancedDraft(jobId: string): void {
  try {
    window.sessionStorage.removeItem(PREFIX + jobId);
    window.sessionStorage.removeItem(LEGACY_PREFIX + jobId);
  } catch { /* storage may be disabled */ }
}

export function saveAdvancedDraft(draft: AdvancedDraft): boolean {
  try {
    window.sessionStorage.setItem(PREFIX + draft.jobId, JSON.stringify(draft));
    window.sessionStorage.removeItem(LEGACY_PREFIX + draft.jobId);
    return true;
  } catch {
    return false;
  }
}

export function loadAdvancedDraft(job: Job): { status: "none" | "restored" | "stale" | "unavailable"; draft?: AdvancedDraft } {
  let raw: string | null;
  try { raw = window.sessionStorage.getItem(PREFIX + job.job_id)
    ?? window.sessionStorage.getItem(LEGACY_PREFIX + job.job_id); }
  catch { return { status: "unavailable" }; }
  if (!raw) return { status: "none" };
  try {
    const draft = JSON.parse(raw) as Omit<AdvancedDraft, "schemaVersion"> & { schemaVersion: number; replaceTrueWithHeader?: boolean };
    const valid = (draft?.schemaVersion === 1 || draft?.schemaVersion === 2)
      && draft.jobId === job.job_id
      && Number.isInteger(draft.configurationRevision)
      && typeof draft.expiresAt === "string"
      && Array.isArray(draft.acknowledged)
      && draft.acknowledged.every((code) => typeof code === "string")
      && Array.isArray(draft.mappingColumns)
      && (draft.replaceTrueWithHeader === undefined || typeof draft.replaceTrueWithHeader === "boolean")
      && draft.mappingColumns.every((column) => column && typeof column.id === "string"
        && typeof column.name === "string" && Array.isArray(column.source_fields)
        && column.source_fields.every((field) => typeof field === "string")
        && (draft.schemaVersion === 1 || typeof column.replace_true_with_header === "boolean")
        && column.transform && typeof column.transform.kind === "string")
      && draft.pleadingSettings
      && ["comma", "semicolon", "pipe", "newline"].includes(draft.pleadingSettings.delimiter)
      && typeof draft.pleadingSettings.include_and === "boolean";
    if (valid && draft.configurationRevision === job.configuration_revision
      && draft.expiresAt === job.expires_at && Date.parse(draft.expiresAt) > Date.now()
      && job.status === "needs_configuration") {
      const { replaceTrueWithHeader, ...current } = draft;
      const enabled = (replaceTrueWithHeader ?? true) && job.analysis?.platform === "logikcull";
      return { status: "restored", draft: { ...current, schemaVersion: 2,
        mappingColumns: draft.mappingColumns.map((column) => ({ ...column,
          replace_true_with_header: column.transform.kind === "shorten_bates" ? false
            : draft.schemaVersion === 1 ? enabled : column.replace_true_with_header,
        })),
      } };
    }
  } catch { /* corrupt or obsolete draft */ }
  clearAdvancedDraft(job.job_id);
  return { status: "stale" };
}
