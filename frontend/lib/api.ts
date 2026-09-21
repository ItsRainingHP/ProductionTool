/**
 * @file Typed browser client for Production Tool job API operations.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import type { Capabilities, Job, MappingConfig, PleadingSettings, Preview, Workflow } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    const detail = typeof body.detail === "string" ? body.detail : body.detail?.message ?? "The request could not be completed.";
    throw new Error(detail);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function uploadErrorMessage(responseText: string): string {
  try {
    const body = JSON.parse(responseText);
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.detail?.message === "string") return body.detail.message;
  } catch {
    // The server did not return JSON; use the safe generic message below.
  }
  return "Upload failed.";
}

export async function createJob(): Promise<{ job_id: string; expires_at: string }> {
  return request("/api/v1/jobs", { method: "POST", body: "{}" });
}

export const getCapabilities = () => request<Capabilities>("/api/v1/capabilities");

export interface UploadTransferProgress {
  loaded: number;
  total: number;
  percent: number;
}

export function uploadSource(
  jobId: string,
  file: File,
  onProgress: (progress: UploadTransferProgress) => void,
  signal?: AbortSignal,
): Promise<Job> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const removeAbortListener = () => signal?.removeEventListener("abort", abortUpload);
    const abortUpload = () => xhr.abort();
    xhr.open("PUT", `/api/v1/jobs/${jobId}/source`);
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
      const percent = total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : 0;
      onProgress({ loaded: Math.min(event.loaded, total), total, percent });
    };
    xhr.onload = () => {
      removeAbortListener();
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(uploadErrorMessage(xhr.responseText)));
    };
    xhr.onerror = () => { removeAbortListener(); reject(new Error("The upload connection failed.")); };
    xhr.onabort = () => { removeAbortListener(); reject(new DOMException("Upload canceled", "AbortError")); };
    const data = new FormData();
    data.append("file", file);
    signal?.addEventListener("abort", abortUpload, { once: true });
    if (signal?.aborted) {
      abortUpload();
      return;
    }
    xhr.send(data);
  });
}

export const getJob = (jobId: string) => request<Job>(`/api/v1/jobs/${jobId}`);
export const setWorkflow = (jobId: string, workflow: Workflow) => request<Job>(`/api/v1/jobs/${jobId}/workflow`, { method: "PUT", body: JSON.stringify({ workflow }) });
export const setMapping = (jobId: string, mapping: MappingConfig) => request<Job>(`/api/v1/jobs/${jobId}/mapping`, { method: "PUT", body: JSON.stringify(mapping) });
export const setPleadingSettings = (jobId: string, settings: PleadingSettings) => request<Job>(`/api/v1/jobs/${jobId}/pleading-settings`, { method: "PUT", body: JSON.stringify(settings) });
export const readyForReview = (jobId: string, acknowledgedIssueCodes: string[]) => request<Job>(`/api/v1/jobs/${jobId}/review`, { method: "POST", body: JSON.stringify({ acknowledged_issue_codes: acknowledgedIssueCodes }) });
export const getPreview = (jobId: string) => request<Preview>(`/api/v1/jobs/${jobId}/preview?limit=5`);
export const finalizeJob = (jobId: string, outputFilename: string, acknowledgedIssueCodes: string[], reviewToken: string) => request<Job>(`/api/v1/jobs/${jobId}/finalize`, { method: "POST", body: JSON.stringify({ output_filename: outputFilename, acknowledged_issue_codes: acknowledgedIssueCodes, review_token: reviewToken }) });
export async function deleteJob(jobId: string): Promise<void> {
  const response = await fetch(`/api/v1/jobs/${jobId}`, { method: "DELETE" });
  if (!response.ok) throw new Error("The job could not be deleted.");
}
