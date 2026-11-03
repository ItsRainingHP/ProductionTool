/** Browser-only tour preferences. Never persist job identifiers or document data. */
export const ONBOARDING_KEY = "production-tool.onboarding.v1";
export const CHAPTERS = ["upload", "data", "advanced-rfp", "advanced-privilege", "review", "download", "mapping-details", "format-details"] as const;
export type TourChapter = (typeof CHAPTERS)[number];
type TourPreference = "new" | "enabled" | "paused" | "skipped";
export type Persistence = "local" | "session" | "memory";
interface TourProgress { completed: boolean; nextTipId: string | null }
export interface OnboardingState {
  schemaVersion: 1;
  preference: TourPreference;
  chapters: Partial<Record<TourChapter, TourProgress>>;
}
export const freshOnboarding = (): OnboardingState => ({ schemaVersion: 1, preference: "new", chapters: {} });

export function parseOnboarding(raw: string | null): OnboardingState | null {
  if (!raw || raw.length > 16384) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.schemaVersion !== 1 || !["new", "enabled", "paused", "skipped"].includes(value.preference)
      || !value.chapters || typeof value.chapters !== "object" || Array.isArray(value.chapters)) return null;
    const chapters: OnboardingState["chapters"] = {};
    for (const id of CHAPTERS) {
      const entry = value.chapters[id];
      if (!entry) continue;
      if (typeof entry.completed !== "boolean" || !(entry.nextTipId === null
        || (typeof entry.nextTipId === "string" && /^[a-z-]{1,64}$/.test(entry.nextTipId)))) return null;
      chapters[id] = { completed: entry.completed, nextTipId: entry.nextTipId };
    }
    return { schemaVersion: 1, preference: value.preference, chapters };
  } catch { return null; }
}

export function readOnboarding(): { state: OnboardingState; persistence: Persistence } {
  let persistence: Persistence = "memory";
  // A session record exists only after a local write failed. Prefer that newer
  // fallback over a potentially stale local record on the next page load.
  for (const kind of ["session", "local"] as const) {
    try {
      const parsed = parseOnboarding(window[`${kind}Storage`].getItem(ONBOARDING_KEY));
      if (parsed) return { state: parsed, persistence: kind };
      persistence = kind;
    } catch { /* Browser storage can be denied. */ }
  }
  return { state: freshOnboarding(), persistence };
}

export function writeOnboarding(state: OnboardingState): Persistence {
  for (const kind of ["local", "session"] as const) {
    try {
      window[`${kind}Storage`].setItem(ONBOARDING_KEY, JSON.stringify(state));
      if (kind === "local") {
        try { window.sessionStorage.removeItem(ONBOARDING_KEY); } catch { /* optional cleanup */ }
      }
      return kind;
    } catch { /* Fall back without blocking the workspace. */ }
  }
  return "memory";
}

export interface TourScreen {
  chapter: Exclude<TourChapter, "mapping-details" | "format-details">;
  ready: boolean;
  deferAutomatic?: boolean;
  blocked?: boolean;
  advisories?: boolean;
  maxUpload?: string;
  retentionHours?: number;
  isTextOutput?: boolean;
}
export interface TourTip { id: string; target: string; title: string; content: string }
export const chapterLabels: Record<TourChapter, string> = {
  upload: "Upload", data: "Data", "advanced-rfp": "Pleading ranges", "advanced-privilege": "Privilege mapping",
  review: "Review", download: "Download", "mapping-details": "Mapping options", "format-details": "Text formatting",
};

export function tourTips(chapter: TourChapter, screen: TourScreen): TourTip[] {
  const tip = (id: string, title: string, content: string): TourTip => ({ id, target: `[data-tour="${id}"]`, title, content });
  switch (chapter) {
    case "upload": return [
      tip("processing-steps", "Welcome to the Production Tool", "Upload a CSV, choose your output, configure it, review a sample, then download. You can return to earlier completed steps."),
      tip("upload-csv", "Start with your CSV", `Choose an Everlaw or Logikcull export, up to ${screen.maxUpload}. Files uploaded are temporary. Backup files accordingly.`),
    ];
    case "data": return [
      tip("analysis-summary", "Understand your source", "The tool checks the CSV and estimates its source from column headings. Confidence score is informational only."),
      tip("validation", "Check the validation results", screen.blocked ? "This file has blocking problems. Read the listed issues and choose a corrected CSV before continuing." : "Blocking issues require a corrected CSV. Recoverable warnings explain output changes; review and acknowledge warnings in Step 3 Advanced menu."),
      ...(screen.advisories ? [tip("personal-data", "Advisories are a separate check", "These findings flag possible personal data for your review. They do not change your source CSV, acknowledge warnings, or prevent you from continuing.")] : []),
      screen.blocked ? tip("replace-csv", "Try a corrected export", "Choose another CSV after correcting the reported problems. Your tour will continue when you reach the next screen.")
        : tip("output-choice", "Choose what you need", "RFP / Pleading Ranges sorts ID numbers by request. Privilege Log allows you to arrange source fields into output columns."),
    ];
    case "advanced-rfp": return [
      tip("range-summary", "Gaps identified in your Bates ranges", "Consecutive document identifiers become shortened ranges. Gaps in documents can occur due to production sort settings."),
      tip("text-formatting", "Choose the text format", "Set the separator between ranges and whether the final range starts with “and.” These options change the output, not your uploaded CSV."),
      tip("review-output", "Review before generating", "Resolve any required warning acknowledgements, then choose Review output to save your settings and prepare a sample."),
    ];
    case "advanced-privilege": return [
      tip("source-fields", "Start with source fields", "These are your CSV headings. Select a field and add it to an output column, or drag it there. A field can be reused."),
      tip("output-columns", "Build the columns you need", "Each card becomes one output column. Rename, reorder, or remove columns, and choose which source fields supply their values."),
      tip("mapping-modes", "Choose how values are built", "Direct copies one field. Bates range combines two identifiers. Join combines populated fields. Fill uses the first populated field in the order shown."),
      tip("mapping-templates", "Reuse a mapping next time", "Save mappings in this browser or import and export JSON templates. Templates contain field mappings only."),
    ];
    case "review": return [
      tip("output-name", "Name your output", "Specify the output file name. Output file determined by workflow."),
      tip("sample-output", "Inspect the sample", `This preview shows ${screen.isTextOutput ? "the first 5,000 characters" : "the first five rows"}, not the entire file. Check the output and skipped-row counts as well as the sample before finalizing.`),
      tip("finalize-output", "Generate the final file", "Finalize applies your workflow settings. This takes you to the final Download step when processing finishes; download does not trigger automatically."),
    ];
    case "download": return [
      tip("download-file", "Download your result", "Save the generated file before this workspace expires. Review the complete downloaded output before relying on it."),
      tip("download-evidence", "Keep the processing receipts", "Receipts describe settings and file hashes. The evidence package bundles output, receipts, and a hash manifest; it does not include your source CSV."),
      tip("finish-workspace", "Finish when you are done", "Process another CSV starts a new job. Finish removes this job and returns home. Save anything you need before finishing or the displayed expiry time."),
    ];
    case "mapping-details": return [
      tip("mapping-modes", "Pick a transformation", "Direct needs one field; Bates range needs two. Join combines nonblank values with a separator. Fill takes the first nonblank value, checking your source order."),
      tip("source-priority", "Source order matters", "Use the arrows to set field priority. Fill checks the fields from top to bottom; Join uses the same order when combining populated values."),
      tip("mapping-options", "Optional changes apply per column", "Normalization cleans names and emails. TRUE replacement uses the source heading only for whole-cell TRUE values, ignoring case and outer spaces. Bates range columns cannot use TRUE replacement."),
      tip("output-columns", "Control the final column order", "Move columns left or right to set their output order. Removing a column removes it from the output mapping, not from your uploaded CSV."),
    ];
    case "format-details": return [
      tip("text-delimiter", "Separate your ranges", "Choose commas, semicolons, pipes, or new lines between Bates ranges under each request heading."),
      tip("text-conjunction", "Choose the final conjunction", "Enable this option to add “and” before the last range. Review the sample to confirm the result matches your preferred format."),
    ];
  }
}
