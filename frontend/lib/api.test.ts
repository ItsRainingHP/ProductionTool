import { afterEach, describe, expect, it, vi } from "vitest";
import { createJob, deleteJob, finalizeJob, getCapabilities, getJob, getPreview, readyForReview, setMapping, setPleadingSettings, setWorkflow, uploadSource } from "./api";

describe("API error messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows FastAPI validation detail messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: [{ loc: ["body", "columns"], msg: "Output column names must be unique" }],
    }), { status: 422, headers: { "Content-Type": "application/json" } })));
    await expect(setMapping("job", { columns: [] })).rejects.toThrow("Output column names must be unique");
  });

  it("explains a network failure without inventing an application sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(createJob()).rejects.toThrow(/private-network connection/);
  });

  it("explains an unexpected HTML response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>login</html>", {
      status: 200, headers: { "Content-Type": "text/html" },
    })));
    await expect(createJob()).rejects.toThrow(/unexpected response/);
  });

  it("explains an upload network failure", async () => {
    class FailedUpload {
      upload = { onprogress: null };
      onerror: (() => void) | null = null;
      open() { /* no request is sent */ }
      setRequestHeader() { /* no request is sent */ }
      send() { this.onerror?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FailedUpload);
    await expect(uploadSource("job", new File(["A,B\n1,2"], "source.csv", { type: "text/csv" }), () => undefined))
      .rejects.toThrow(/private-network connection/);
  });

  it("sends the full job lifecycle to the expected endpoints", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await createJob();
    await getCapabilities();
    await getJob("job-1");
    await setWorkflow("job-1", "rfp_ranges");
    await setMapping("job-1", { columns: [] });
    await setPleadingSettings("job-1", { delimiter: "comma", include_and: true });
    await readyForReview("job-1", ["uneven_row_width"]);
    await getPreview("job-1");
    await finalizeJob("job-1", "output", [], "review-token");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/jobs", "/api/v1/capabilities", "/api/v1/jobs/job-1",
      "/api/v1/jobs/job-1/workflow", "/api/v1/jobs/job-1/mapping",
      "/api/v1/jobs/job-1/pleading-settings", "/api/v1/jobs/job-1/review",
      "/api/v1/jobs/job-1/preview?limit=5", "/api/v1/jobs/job-1/finalize",
    ]);
    expect(fetcher.mock.calls[6][1].body).toBe(JSON.stringify({ acknowledged_issue_codes: ["uneven_row_width"] }));
    expect(fetcher.mock.calls[8][1].body).toContain('"review_token":"review-token"');
  });

  it("handles empty, structured, and unstructured server responses", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { message: "Workspace expired" } }), { status: 410 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Upload rejected" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: [{ other: "missing message" }] }), { status: 422 }))
      .mockResolvedValueOnce(new Response("not-json", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(createJob()).resolves.toBeUndefined();
    await expect(createJob()).rejects.toThrow("Workspace expired");
    await expect(createJob()).rejects.toThrow("Upload rejected");
    await expect(createJob()).rejects.toThrow("The request could not be completed.");
    await expect(createJob()).rejects.toThrow(/unexpected response/);
  });

  it("preserves an aborted request and reports failed deletion", async () => {
    const abort = new DOMException("Canceled", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(createJob()).rejects.toBe(abort);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(deleteJob("job-1")).rejects.toThrow("The job could not be deleted.");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(deleteJob("job-1")).resolves.toBe("deleted");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
    await expect(deleteJob("job-1")).resolves.toBe("pending");
  });

  it("streams upload progress and accepts a successful response", async () => {
    const progress = vi.fn();
    const sent: Array<{ file: File; xhr: UploadRequest }> = [];
    class UploadRequest {
      static current: UploadRequest;
      upload: { onprogress: ((event: { lengthComputable: boolean; total: number; loaded: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 200;
      responseText = '{"job_id":"job-1"}';
      headers: Record<string, string> = {};
      constructor() { UploadRequest.current = this; }
      open(method: string, url: string) { expect([method, url]).toEqual(["PUT", "/api/v1/jobs/job-1/source"]); }
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send(file: File) { sent.push({ file, xhr: this }); }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
    const file = new File(["A,B\n1,2"], "source.csv", { type: "text/csv" });
    const result = uploadSource("job-1", file, progress);
    const xhr = UploadRequest.current;
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 99, total: 0 });
    expect(progress).toHaveBeenNthCalledWith(1, { loaded: 4, total: 100, percent: 4 });
    expect(progress).toHaveBeenNthCalledWith(2, { loaded: file.size, total: file.size, percent: 100 });
    expect(xhr.headers["X-File-Name"]).toBe("source.csv");
    expect(sent[0].file).toBe(file);
    xhr.onload?.();
    await expect(result).resolves.toEqual({ job_id: "job-1" });
  });

  it("reports upload rejection, malformed success, and cancellation", async () => {
    class UploadRequest {
      static current: UploadRequest;
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 200;
      responseText = "{}";
      constructor() { UploadRequest.current = this; }
      open() { /* request captured below */ }
      setRequestHeader() { /* headers are exercised in the success test */ }
      send() { /* callbacks are controlled by the test */ }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
    const file = new File(["A,B\n1,2"], "source.csv", { type: "text/csv" });
    const rejected = uploadSource("job-1", file, () => undefined);
    UploadRequest.current.status = 422;
    UploadRequest.current.responseText = '{"detail":"CSV exceeds the upload limit"}';
    UploadRequest.current.onload?.();
    await expect(rejected).rejects.toThrow("CSV exceeds the upload limit");

    const redirected = uploadSource("job-1", file, () => undefined);
    UploadRequest.current.status = 401;
    UploadRequest.current.responseText = "<html>sign in</html>";
    UploadRequest.current.onload?.();
    await expect(redirected).rejects.toThrow(/Access was denied/);

    const malformed = uploadSource("job-1", file, () => undefined);
    UploadRequest.current.responseText = "not-json";
    UploadRequest.current.onload?.();
    await expect(malformed).rejects.toThrow(/unexpected response/);

    const controller = new AbortController();
    const canceled = uploadSource("job-1", file, () => undefined, controller.signal);
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(uploadSource("job-1", file, () => undefined, preAborted.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
