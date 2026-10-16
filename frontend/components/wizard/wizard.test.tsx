import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import type { Analysis, Job, Preview } from "../../lib/types";
import { createJob, deleteJob, finalizeJob, getCapabilities, getJob, getPreview, inspectMappingBlanks, readyForReview, setMapping, setPleadingSettings, setWorkflow, uploadSource } from "../../lib/api";
import { Wizard } from "./wizard";

const navigation = vi.hoisted(() => ({
  segments: [] as string[],
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ segments: navigation.segments }),
  useRouter: () => navigation,
}));
vi.mock("../../lib/api", () => ({
  createJob: vi.fn(), deleteJob: vi.fn(), finalizeJob: vi.fn(), getCapabilities: vi.fn(),
  getJob: vi.fn(), getPreview: vi.fn(), inspectMappingBlanks: vi.fn(), readyForReview: vi.fn(), setMapping: vi.fn(),
  setPleadingSettings: vi.fn(), setWorkflow: vi.fn(), uploadSource: vi.fn(),
}));

const analysis: Analysis = {
  filename: "source.csv", size_bytes: 55, row_count: 2, column_count: 3,
  headers: ["Begin Bates", "End Bates", "Tag: RFP 01"],
  true_blank_headers: [],
  detected_workflow: "rfp_ranges", rfp_layout: "separate",
  begin_bates_header: "Begin Bates", end_bates_header: "End Bates",
  platform: "unknown", platform_confidence: 0, prefixes: ["ABC"],
  request_count: 1, duplicate_ranges: 0, gap_count: 0, personal_data_findings: [],
  issues: [{ code: "uneven_row_width", severity: "warning", message: "One row will be excluded.",
    count: 1, overrideable: true, row: 3, column: null }],
};
const reviewed = {
  job_id: "job-1", status: "ready_for_review", analysis, workflow: "rfp_ranges",
  reviewed_issue_codes: ["uneven_row_width"], review_token: "a".repeat(40),
  pleading_settings: { delimiter: "comma", include_and: true },
  expires_at: "2099-10-09T00:00:00Z", configuration_revision: 1, revision: 1,
  progress: { phase: "", percent: 100 },
  output_stats: null, mapping: null, error: null,
} as unknown as Job;
const preview = {
  headers: ["RFP", "Bates Range"], rows: [], text: "RFP 01\r\nABC0001-0002\r\n",
  total_rows: 1, skipped_rows: 1, formula_escapes: 0,
  configuration_revision: 1, sample_truncated: false,
} as Preview;

describe("wizard recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigation.segments = [];
    window.sessionStorage.clear();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(),
    } });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    vi.mocked(getCapabilities).mockResolvedValue({
      max_upload_bytes: 524288000, job_ttl_seconds: 14400, max_active_jobs: 20,
      max_total_job_bytes: 5368709120, supported_content_types: ["text/csv", ""], features: [],
    });
    vi.mocked(inspectMappingBlanks).mockResolvedValue({ blank_cells: [0], output_rows: 2 });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("shows the worker error on a resumed analysis with no result", async () => {
    navigation.segments = ["job-1", "upload"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "failed", analysis: null,
      workflow: "privilege_log", error: "CSV analysis was interrupted" });
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("alert")).toHaveTextContent("CSV analysis was interrupted");
    expect(screen.getByRole("heading", { name: "Upload CSV data" })).toBeVisible();
  });

  it("stays on Upload and shows a new analysis failure", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.mocked(createJob).mockResolvedValue({ job_id: "new-job", expires_at: "2026-10-09T00:00:00Z" });
    vi.mocked(uploadSource).mockResolvedValue({ ...reviewed, job_id: "new-job", status: "analyzing", analysis: null });
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, job_id: "new-job", status: "failed", analysis: null,
      error: "CSV analysis was interrupted" });
    render(<Providers><Wizard /></Providers>);
    fireEvent.change(screen.getByLabelText("Upload source CSV"), {
      target: { files: [new File(["A,B\n1,2\n"], "source.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("CSV analysis was interrupted");
    expect(screen.getByRole("heading", { name: "Upload CSV data" })).toBeVisible();
    expect(navigation.replace).not.toHaveBeenCalledWith(expect.stringMatching(/\/data$/));
  });

  it("restores warning acknowledgments when Review is reloaded", async () => {
    navigation.segments = ["job-1", "review"];
    vi.mocked(getJob).mockResolvedValue(reviewed);
    vi.mocked(getPreview).mockResolvedValue(preview);
    vi.mocked(finalizeJob).mockResolvedValue({ ...reviewed, status: "processing" });
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Finalize with warnings" }));
    await waitFor(() => expect(finalizeJob).toHaveBeenCalledWith(
      "job-1", "source_rfp_ranges", ["uneven_row_width"], reviewed.review_token,
    ));
  });

  it("blocks duplicate output column names before sending a mapping", async () => {
    navigation.segments = ["job-1", "advanced"];
    const column = { id: "one", name: "Author", source_fields: ["Begin Bates"],
      transform: { kind: "none", delimiter: null }, normalize: false };
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "needs_configuration", workflow: "privilege_log",
      mapping: { columns: [column, { ...column, id: "two", name: "author" }] } } as Job);
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("button", { name: "Review output" })).toBeDisabled();
  });

  it("waits for a ready review before requesting its preview", async () => {
    navigation.segments = ["job-1", "review"];
    let finishPreparation: (value: Job) => void = () => undefined;
    vi.mocked(getJob).mockResolvedValueOnce({ ...reviewed, status: "preparing_review" })
      .mockImplementationOnce(() => new Promise((resolve) => { finishPreparation = resolve; }));
    vi.mocked(getPreview).mockResolvedValue(preview);
    render(<Providers><Wizard /></Providers>);
    await waitFor(() => expect(getJob).toHaveBeenCalledTimes(2));
    expect(getPreview).not.toHaveBeenCalled();
    finishPreparation(reviewed);
    await waitFor(() => expect(getPreview).toHaveBeenCalledTimes(1));
  });

  it("cancels finalize without leaving a stale error or hiding the next error", async () => {
    navigation.segments = ["job-1", "review"];
    let rejectPoll: (reason: Error) => void = () => undefined;
    vi.mocked(getJob).mockResolvedValueOnce(reviewed)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPoll = reject; }));
    vi.mocked(getPreview).mockResolvedValue(preview);
    vi.mocked(finalizeJob).mockResolvedValue({ ...reviewed, status: "processing" });
    vi.mocked(deleteJob).mockResolvedValue("deleted");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.mocked(createJob).mockRejectedValue(new Error("Second upload failed"));
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Finalize with warnings" }));
    await waitFor(() => expect(getJob).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel processing" }));
    expect(await screen.findByRole("heading", { name: "Upload CSV data" })).toBeVisible();
    rejectPoll(new Error("Job not found"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Upload source CSV"), {
      target: { files: [new File(["A,B\n1,2\n"], "second.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Second upload failed");
  });

  it("aborts an active upload when the wizard unmounts", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.mocked(createJob).mockResolvedValue({ job_id: "new-job", expires_at: "2026-10-09T00:00:00Z" });
    let signal: AbortSignal | undefined;
    vi.mocked(uploadSource).mockImplementation((_id, _file, _progress, uploadSignal) => {
      signal = uploadSignal;
      return new Promise(() => undefined);
    });
    vi.mocked(deleteJob).mockResolvedValue("deleted");
    const view = render(<Providers><Wizard /></Providers>);
    fireEvent.change(screen.getByLabelText("Upload source CSV"), {
      target: { files: [new File(["A,B\n1,2\n"], "source.csv", { type: "text/csv" })] },
    });
    await waitFor(() => expect(uploadSource).toHaveBeenCalled());
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("rejects an invalid CSV locally and processes a valid upload into the Data step", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.mocked(createJob).mockResolvedValue({ job_id: "new-job", expires_at: reviewed.expires_at });
    vi.mocked(uploadSource).mockImplementation(async (_id, _file, progress) => {
      progress({ loaded: 12, total: 12, percent: 100 });
      return { ...reviewed, job_id: "new-job", status: "analyzing", analysis: null };
    });
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, job_id: "new-job", status: "needs_configuration", analysis: { ...analysis, issues: [] } });
    const view = render(<Providers><Wizard /></Providers>);
    fireEvent.change(screen.getByLabelText("Upload source CSV"), {
      target: { files: [new File(["bad"], "source.txt", { type: "text/plain" })] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/CSV/i);
    expect(createJob).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Upload source CSV"), {
      target: { files: [new File(["A,B\n1,2\n"], "source.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByRole("heading", { name: "Choose the output" })).toBeVisible();
    expect(uploadSource).toHaveBeenCalledWith("new-job", expect.any(File), expect.any(Function), expect.any(AbortSignal));
    expect(navigation.replace).toHaveBeenCalledWith("/wizard/new-job/data");
    navigation.segments = ["new-job", "data"];
    view.rerender(<Providers><Wizard /></Providers>);
    await waitFor(() => expect(getJob).toHaveBeenCalledTimes(2));
  });

  it("chooses a workflow and saves RFP settings before showing the reviewed sample", async () => {
    navigation.segments = ["job-1", "data"];
    const clean = { ...analysis, issues: [] };
    const configured = { ...reviewed, analysis: clean, status: "needs_configuration", reviewed_issue_codes: [] } as Job;
    vi.mocked(getJob).mockResolvedValueOnce(configured).mockResolvedValueOnce({ ...reviewed, analysis: clean });
    vi.mocked(setWorkflow).mockResolvedValue(configured);
    vi.mocked(setPleadingSettings).mockResolvedValue(configured);
    vi.mocked(readyForReview).mockResolvedValue({ ...configured, status: "preparing_review" });
    vi.mocked(getPreview).mockResolvedValue(preview);
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Inspect pleading ranges" })).toBeVisible();
    expect(setWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review output" }));
    expect(await screen.findByRole("heading", { name: "Review your output" })).toBeVisible();
    expect(setPleadingSettings).toHaveBeenCalledWith("job-1", { delimiter: "comma", include_and: true });
    expect(readyForReview).toHaveBeenCalledWith("job-1", []);
    await waitFor(() => expect(getPreview).toHaveBeenCalledWith("job-1", expect.any(AbortSignal)));
    expect(await screen.findByText(/ABC0001-0002/)).toBeInTheDocument();
  });

  it("preserves unsaved privilege mapping changes until review and submits the mapping", async () => {
    navigation.segments = ["job-1", "advanced"];
    const column = { id: "author", name: "Author", source_fields: ["Begin Bates"],
      transform: { kind: "none" as const, delimiter: null }, normalize: false };
    const configured = { ...reviewed, status: "needs_configuration", workflow: "privilege_log", analysis: { ...analysis, issues: [] },
      mapping: { columns: [column] } } as Job;
    vi.mocked(getJob).mockResolvedValueOnce(configured).mockResolvedValueOnce({ ...configured, status: "ready_for_review" });
    vi.mocked(setMapping).mockResolvedValue(configured);
    vi.mocked(readyForReview).mockResolvedValue({ ...configured, status: "preparing_review" });
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("heading", { name: "Build privilege output" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Output column 1"), { target: { value: "Reviewer" } });
    expect(screen.getByText(/Unsaved changes\. They are saved/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review output" }));
    expect(await screen.findByRole("heading", { name: "Review your output" })).toBeVisible();
    expect(setMapping).toHaveBeenCalledWith("job-1", { columns: [expect.objectContaining({ name: "Reviewer" })] });
  });

  it("finalizes a reviewed CSV, exposes receipts, and clears the workspace on finish", async () => {
    navigation.segments = ["job-1", "review"];
    const privilege = { ...reviewed, workflow: "privilege_log", analysis: { ...analysis, issues: [] },
      output_filename: "privilege.csv" } as Job;
    const completed = { ...privilege, status: "complete", output_stats: {
      output_size_bytes: 123, output_rows: 2, output_cells: 6, processing_ms: 25,
      skipped_rows: 0, formula_escapes: 1,
    } } as Job;
    vi.mocked(getJob).mockResolvedValueOnce(privilege).mockResolvedValueOnce(completed);
    vi.mocked(getPreview).mockResolvedValue({ ...preview, headers: ["Author"], rows: [["Reviewer"]], text: null });
    vi.mocked(finalizeJob).mockResolvedValue({ ...privilege, status: "processing" });
    vi.mocked(deleteJob).mockResolvedValue("deleted");
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Finalize CSV" }));
    expect(await screen.findByRole("heading", { name: "Your CSV is ready" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/v1/jobs/job-1/download");
    expect(screen.getByRole("link", { name: "Evidence package" })).toHaveAttribute("href", "/api/v1/jobs/job-1/evidence.zip");
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("job-1"));
    expect(navigation.push).toHaveBeenCalledWith("/");
    expect(screen.getByRole("heading", { name: "Upload CSV data" })).toBeVisible();
  });

  it("reports a missing review sample and keeps the review action available", async () => {
    navigation.segments = ["job-1", "review"];
    vi.mocked(getJob).mockResolvedValue(reviewed);
    vi.mocked(getPreview).mockRejectedValue(new Error("Preview service unavailable"));
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview service unavailable");
    expect(screen.getByRole("button", { name: "Finalize with warnings" })).toBeEnabled();
  });

  it("recovers from an expired route and redirects an inaccessible future step", async () => {
    navigation.segments = ["job-1", "review"];
    window.sessionStorage.setItem("production-tool.advanced-draft.v1.job-1", "expired draft");
    vi.mocked(getJob).mockRejectedValueOnce(new Error("Job expired"));
    const expired = render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("alert")).toHaveTextContent("expired. Start a new upload");
    expect(navigation.replace).toHaveBeenCalledWith("/wizard");
    expect(window.sessionStorage.getItem("production-tool.advanced-draft.v1.job-1")).toBeNull();
    expired.unmount();

    vi.clearAllMocks();
    navigation.segments = ["job-1", "download"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "needs_configuration", analysis: { ...analysis, issues: [] } });
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("heading", { name: "Inspect pleading ranges" })).toBeVisible();
    expect(navigation.replace).toHaveBeenCalledWith("/wizard/job-1/advanced");
  });

  it("polls a resumed analysis until it reaches Data", async () => {
    navigation.segments = ["job-1", "upload"];
    vi.mocked(getJob).mockResolvedValueOnce({ ...reviewed, status: "analyzing", analysis: null })
      .mockResolvedValueOnce({ ...reviewed, status: "analyzing", analysis: null })
      .mockResolvedValueOnce({ ...reviewed, status: "needs_configuration", analysis: { ...analysis, issues: [] } });
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("heading", { name: "Choose the output" })).toBeVisible();
    expect(getJob).toHaveBeenCalledTimes(3);
    expect(navigation.replace).toHaveBeenCalledWith("/wizard/job-1/data");
  });

  it("keeps a failed upload visible when capabilities cannot be loaded", async () => {
    vi.mocked(getCapabilities).mockRejectedValue(new Error("offline"));
    vi.mocked(createJob).mockRejectedValue(new Error("Upload service unavailable"));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    render(<Providers><Wizard /></Providers>);
    expect(screen.getByText(/after 4 hours/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Upload source CSV"), {
      target: { files: [new File(["A,B\n1,2"], "source.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload service unavailable");
    expect(screen.getByRole("heading", { name: "Upload CSV data" })).toBeVisible();
  });

  it("uses keyboard and drop actions on the upload zone", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.mocked(createJob).mockRejectedValue(new Error("Upload unavailable"));
    render(<Providers><Wizard /></Providers>);
    const chooser = screen.getByLabelText("Upload source CSV") as HTMLInputElement;
    const open = vi.spyOn(chooser, "click").mockImplementation(() => undefined);
    const zone = screen.getByRole("button", { name: "Choose a CSV file" });
    fireEvent.click(zone);
    fireEvent.keyDown(zone, { key: "Enter" });
    fireEvent.keyDown(zone, { key: " " });
    expect(open).toHaveBeenCalledTimes(4);
    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["A,B\n1,2"], "source.csv", { type: "text/csv" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload unavailable");
  });

  it("removes a previous failed job before a replacement upload", async () => {
    navigation.segments = ["job-1", "upload"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "failed", analysis: null });
    vi.mocked(deleteJob).mockResolvedValue("deleted");
    vi.mocked(createJob).mockRejectedValue(new Error("Cannot create replacement"));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("heading", { name: "Upload CSV data" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Upload source CSV"), {
      target: { files: [new File(["A,B\n1,2"], "next.csv", { type: "text/csv" })] },
    });
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("job-1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot create replacement");
  });

  it("shows a workflow save error without advancing", async () => {
    navigation.segments = ["job-1", "data"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, workflow: null, status: "needs_configuration", analysis: { ...analysis, issues: [] } });
    vi.mocked(setWorkflow).mockRejectedValue(new Error("Save was interrupted"));
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save was interrupted");
    expect(screen.getByRole("heading", { name: "Choose the output" })).toBeVisible();
  });

  it("acknowledges warnings and protects edited pleading settings", async () => {
    navigation.segments = ["job-1", "advanced"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "needs_configuration", reviewed_issue_codes: [] });
    render(<Providers><Wizard /></Providers>);
    const review = await screen.findByRole("button", { name: "Review output" });
    expect(review).toBeDisabled();
    const warning = screen.getByRole("checkbox", { name: /understand how this issue affects/i });
    fireEvent.click(warning);
    expect(review).toBeEnabled();
    fireEvent.click(warning);
    expect(review).toBeDisabled();
    fireEvent.click(warning);
    fireEvent.click(screen.getByRole("button", { name: "Pipe" }));
    expect(screen.getByText(/Unsaved changes\. They are saved/)).toBeVisible();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it("restores an unsaved Advanced draft after browser history and refresh", async () => {
    navigation.segments = ["job-1", "advanced"];
    const configured = { ...reviewed, status: "needs_configuration", reviewed_issue_codes: [] } as Job;
    vi.mocked(getJob).mockResolvedValue(configured);
    const view = render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Semicolon" }));
    await waitFor(() => expect(window.sessionStorage.getItem("production-tool.advanced-draft.v1.job-1"))
      .toContain('"delimiter":"semicolon"'));

    navigation.segments = ["job-1", "data"];
    view.rerender(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("heading", { name: "Choose the output" })).toBeVisible();
    navigation.segments = ["job-1", "advanced"];
    view.rerender(<Providers><Wizard /></Providers>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Semicolon" })).toHaveAttribute("aria-pressed", "true"));

    view.unmount();
    render(<Providers><Wizard /></Providers>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Semicolon" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("keeps an Advanced draft through Previous and clears it on explicit discard", async () => {
    navigation.segments = ["job-1", "advanced"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "needs_configuration", reviewed_issue_codes: [] });
    const view = render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Pipe" }));
    await waitFor(() => expect(window.sessionStorage.getItem("production-tool.advanced-draft.v1.job-1"))
      .toContain('"delimiter":"pipe"'));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.push).toHaveBeenCalledWith("/wizard/job-1/data");
    expect(window.sessionStorage.getItem("production-tool.advanced-draft.v1.job-1")).toContain('"delimiter":"pipe"');
    navigation.segments = ["job-1", "data"];
    view.rerender(<Providers><Wizard /></Providers>);
    navigation.segments = ["job-1", "advanced"];
    view.rerender(<Providers><Wizard /></Providers>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pipe" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(window.sessionStorage.getItem("production-tool.advanced-draft.v1.job-1")).toBeNull();
  });

  it("warns before leaving Advanced when tab storage rejects the draft", async () => {
    navigation.segments = ["job-1", "advanced"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "needs_configuration", reviewed_issue_codes: [] });
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
      clear: () => undefined,
    });
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Pipe" }));
    expect(await screen.findByText(/This tab could not save your draft/)).toBeVisible();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.push).not.toHaveBeenCalledWith("/wizard/job-1/data");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.push).toHaveBeenCalledWith("/wizard/job-1/data");
  });

  it("reports failed review preparation and failed finalization", async () => {
    navigation.segments = ["job-1", "advanced"];
    const clean = { ...analysis, issues: [] };
    vi.mocked(getJob).mockResolvedValueOnce({ ...reviewed, status: "needs_configuration", analysis: clean })
      .mockResolvedValueOnce({ ...reviewed, status: "failed", analysis: clean, error: "Review file could not be prepared" });
    vi.mocked(setPleadingSettings).mockResolvedValue({ ...reviewed, status: "needs_configuration", analysis: clean });
    vi.mocked(readyForReview).mockResolvedValue({ ...reviewed, status: "preparing_review", analysis: clean });
    const failedReview = render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Review output" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review file could not be prepared");
    failedReview.unmount();

    vi.clearAllMocks();
    navigation.segments = ["job-1", "review"];
    vi.mocked(getJob).mockResolvedValueOnce(reviewed)
      .mockResolvedValueOnce({ ...reviewed, status: "failed", error: "Final package failed" });
    vi.mocked(getPreview).mockResolvedValue(preview);
    vi.mocked(finalizeJob).mockResolvedValue({ ...reviewed, status: "processing" });
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Finalize with warnings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Final package failed");
  });

  it("clears the draft once Advanced settings save even if review preparation fails", async () => {
    navigation.segments = ["job-1", "advanced"];
    const configured = { ...reviewed, status: "needs_configuration", analysis: { ...analysis, issues: [] } } as Job;
    vi.mocked(getJob).mockResolvedValue(configured);
    vi.mocked(setPleadingSettings).mockResolvedValue({ ...configured, configuration_revision: 2 });
    vi.mocked(readyForReview).mockRejectedValue(new Error("Review unavailable"));
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Pipe" }));
    await waitFor(() => expect(window.sessionStorage.getItem("production-tool.advanced-draft.v1.job-1"))
      .toContain('"delimiter":"pipe"'));
    fireEvent.click(screen.getByRole("button", { name: "Review output" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review unavailable");
    expect(window.sessionStorage.getItem("production-tool.advanced-draft.v1.job-1")).toBeNull();
    expect(screen.getByRole("button", { name: "Pipe" })).toHaveAttribute("aria-pressed", "true");
  });

  it("requires a review token and strips a typed filename suffix", async () => {
    navigation.segments = ["job-1", "review"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, review_token: null });
    vi.mocked(getPreview).mockResolvedValue(preview);
    const missingToken = render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Finalize with warnings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Prepare the current output for review");
    missingToken.unmount();

    vi.clearAllMocks();
    vi.mocked(getJob).mockResolvedValue(reviewed);
    vi.mocked(getPreview).mockResolvedValue(preview);
    vi.mocked(finalizeJob).mockRejectedValue(new Error("Could not finalize"));
    render(<Providers><Wizard /></Providers>);
    const name = await screen.findByLabelText("Output filename");
    fireEvent.change(name, { target: { value: "matter.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Finalize with warnings" }));
    await waitFor(() => expect(finalizeJob).toHaveBeenCalledWith("job-1", "matter", ["uneven_row_width"], reviewed.review_token));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not finalize");
  });

  it("reports a failed cancellation while retaining the current review", async () => {
    navigation.segments = ["job-1", "review"];
    vi.mocked(getJob).mockResolvedValueOnce(reviewed).mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(getPreview).mockResolvedValue(preview);
    vi.mocked(finalizeJob).mockResolvedValue({ ...reviewed, status: "processing" });
    vi.mocked(deleteJob).mockRejectedValue(new Error("Unable to remove workspace"));
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Finalize with warnings" }));
    const cancel = await screen.findByRole("button", { name: "Cancel processing" });
    fireEvent.click(screen.getByRole("button", { name: /Upload/ }));
    expect(screen.getByRole("heading", { name: "Review your output" })).toBeVisible();
    fireEvent.click(cancel);
    expect(deleteJob).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(await screen.findByText(/Deletion could not be confirmed\. Unable to remove workspace/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Review your output" })).toBeVisible();
  });

  it("returns from Data to Upload and replaces a blocked CSV", async () => {
    navigation.segments = ["job-1", "data"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "needs_configuration", analysis: { ...analysis, issues: [] } });
    const normal = render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Previous" }));
    expect(screen.getByRole("heading", { name: "Upload CSV data" })).toBeVisible();
    expect(navigation.push).toHaveBeenCalledWith("/wizard/job-1/upload");
    normal.unmount();

    vi.clearAllMocks();
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "failed", analysis: {
      ...analysis, issues: [{ ...analysis.issues[0], severity: "error", overrideable: false }],
    } });
    render(<Providers><Wizard /></Providers>);
    const input = screen.getByLabelText("Upload source CSV") as HTMLInputElement;
    const open = vi.spyOn(input, "click").mockImplementation(() => undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Choose another CSV" }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Review CSV problems" })).toBeVisible();
  });

  it("builds default privilege columns after selecting that workflow", async () => {
    navigation.segments = ["job-1", "data"];
    const undecided = { ...reviewed, workflow: null, status: "needs_configuration",
      analysis: { ...analysis, detected_workflow: "unknown", issues: [] }, reviewed_issue_codes: [] } as Job;
    vi.mocked(getJob).mockResolvedValue(undecided);
    vi.mocked(setWorkflow).mockResolvedValue({ ...undecided, workflow: "privilege_log" });
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("radio", { name: /Privilege Log/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Build privilege output" })).toBeVisible();
    expect(setWorkflow).toHaveBeenCalledWith("job-1", "privilege_log");
    expect(screen.getByLabelText("Output column 1")).toHaveValue("Bates Range");
  });

  it("applies a template and identifies source fields absent from the CSV", async () => {
    navigation.segments = ["job-1", "advanced"];
    const missing = { schemaVersion: 1, id: "template-1", name: "Old fields",
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
      columns: [{ id: "old", name: "Old", source_fields: ["Absent"],
        transform: { kind: "none", delimiter: null }, normalize: false }],
    };
    vi.mocked(window.localStorage.getItem).mockReturnValue(JSON.stringify([missing]));
    const column = { id: "current", name: "Current", source_fields: ["Begin Bates"],
      transform: { kind: "none" as const, delimiter: null }, normalize: false };
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, workflow: "privilege_log", status: "needs_configuration",
      analysis: { ...analysis, issues: [] }, mapping: { columns: [column] } } as Job);
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Template fields not present in this CSV: Absent");
    expect(screen.getByRole("button", { name: "Review output" })).toBeDisabled();
    expect(screen.getByText(/Unsaved changes\. They are saved/)).toBeVisible();
  });

  it.each([
    { columns: [{ id: "empty", name: "Empty", source_fields: [], transform: { kind: "none", delimiter: null }, normalize: false }] },
    { columns: [{ id: "duplicate", name: "Duplicate", source_fields: ["Begin Bates", "Begin Bates"], transform: { kind: "fill", delimiter: null }, normalize: false }] },
    { columns: [{ id: "separator", name: "Separator", source_fields: ["Begin Bates", "End Bates"], transform: { kind: "delimit", delimiter: null }, normalize: false }] },
  ])("blocks an incomplete privilege mapping before review", async ({ columns }) => {
    navigation.segments = ["job-1", "advanced"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, workflow: "privilege_log", status: "needs_configuration",
      analysis: { ...analysis, issues: [] }, mapping: { columns } } as Job);
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("button", { name: "Review output" })).toBeDisabled();
    expect(readyForReview).not.toHaveBeenCalled();
  });

  it("returns from Review to Advanced and finishes a completed text job", async () => {
    navigation.segments = ["job-1", "review"];
    vi.mocked(getJob).mockResolvedValue(reviewed);
    vi.mocked(getPreview).mockResolvedValue(preview);
    const reviewView = render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Previous" }));
    expect(screen.getByRole("heading", { name: "Inspect pleading ranges" })).toBeVisible();
    reviewView.unmount();

    vi.clearAllMocks();
    navigation.segments = ["job-1", "download"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "complete", output_filename: "ranges.txt",
      output_stats: { output_size_bytes: 50, output_rows: 1, output_cells: 2,
        processing_ms: 1, skipped_rows: 0, formula_escapes: 0 } } as Job);
    vi.mocked(deleteJob).mockResolvedValue("pending");
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Process another CSV" }));
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("job-1"));
    expect(navigation.push).not.toHaveBeenCalledWith("/wizard");
    expect(screen.getByRole("status")).toHaveTextContent("Deletion is pending");
    vi.mocked(deleteJob).mockResolvedValue("deleted");
    fireEvent.click(screen.getByRole("button", { name: "Check or retry deletion" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/wizard"));
    expect(screen.getByRole("heading", { name: "Upload CSV data" })).toBeVisible();
  });

  it("reports an analysis failure after resuming an active job", async () => {
    navigation.segments = ["job-1", "upload"];
    vi.mocked(getJob).mockResolvedValueOnce({ ...reviewed, status: "analyzing", analysis: null })
      .mockResolvedValueOnce({ ...reviewed, status: "failed", analysis: null, error: "Analysis crashed" });
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Analysis crashed");
    expect(navigation.replace).toHaveBeenCalledWith("/wizard/job-1/upload");
  });

  it("keeps a deletion-pending job reference after reopening its URL", async () => {
    navigation.segments = ["job-1", "download"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "complete", error_code: "deletion_pending" });
    vi.mocked(deleteJob).mockResolvedValue("deleted");
    render(<Providers><Wizard /></Providers>);
    expect(await screen.findByText(/Deletion is pending\. Job files may still be retained/)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("job-1");
    fireEvent.click(screen.getByRole("button", { name: "Check or retry deletion" }));
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("job-1"));
  });

  it("retains a previous job when deletion fails before a replacement upload", async () => {
    navigation.segments = ["job-1", "upload"];
    vi.mocked(getJob).mockResolvedValue({ ...reviewed, status: "failed", analysis: null });
    vi.mocked(deleteJob).mockRejectedValue(new Error("already gone"));
    vi.mocked(createJob).mockRejectedValue(new Error("New job unavailable"));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    render(<Providers><Wizard /></Providers>);
    await screen.findByRole("heading", { name: "Upload CSV data" });
    fireEvent.change(screen.getByLabelText("Upload source CSV"), {
      target: { files: [new File(["A,B\n1,2"], "next.csv", { type: "text/csv" })] },
    });
    expect(await screen.findByText(/Deletion could not be confirmed\. already gone/)).toBeVisible();
    expect(deleteJob).toHaveBeenCalledWith("job-1");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("cancels an active upload and removes its temporary job", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.mocked(createJob).mockResolvedValue({ job_id: "new-job", expires_at: reviewed.expires_at });
    vi.mocked(uploadSource).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(deleteJob).mockResolvedValue("deleted");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Providers><Wizard /></Providers>);
    fireEvent.change(screen.getByLabelText("Upload source CSV"), {
      target: { files: [new File(["A,B\n1,2"], "source.csv", { type: "text/csv" })] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel and remove workspace" }));
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("new-job"));
    expect(screen.getByRole("heading", { name: "Upload CSV data" })).toBeVisible();
  });

  it("cancels a resumed analysis from its progress panel", async () => {
    navigation.segments = ["job-1", "upload"];
    vi.mocked(getJob).mockResolvedValueOnce({ ...reviewed, status: "analyzing", analysis: null })
      .mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(deleteJob).mockResolvedValue("deleted");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Providers><Wizard /></Providers>);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel and remove workspace" }));
    await waitFor(() => expect(deleteJob).toHaveBeenCalledWith("job-1"));
    expect(navigation.replace).toHaveBeenCalledWith("/wizard");
  });
});
