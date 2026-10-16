/**
 * @file Typed browser client for Production Tool job API operations.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import type { Capabilities, Job, MappingBlankReport, MappingConfig, PleadingSettings, Preview, Workflow } from "./types";

const SERVICE_MESSAGE = "The production service could not be reached or returned an unexpected response. Check your private-network connection and try again, or contact the service operator.";
const ACCESS_MESSAGE = "Access was denied. Check your approved private-network connection or contact the service operator.";

function responseDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => item && typeof item.msg === "string" ? item.msg : null).filter(Boolean);
    if (messages.length) return messages.join("; ");
  }
  if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") return detail.message;
  return "The request could not be completed.";
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
  }).catch((reason) => {
    if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
    throw new Error(SERVICE_MESSAGE);
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (!body) throw new Error([401, 403].includes(response.status) ? ACCESS_MESSAGE : SERVICE_MESSAGE);
    throw new Error(responseDetail(body.detail));
  }
  if (response.status === 204) return undefined as T;
  return response.json().catch(() => { throw new Error(SERVICE_MESSAGE); });
}

function uploadErrorMessage(responseText: string, status: number): string {
  try {
    const body = JSON.parse(responseText);
    return responseDetail(body.detail);
  } catch {
    // The server did not return JSON; use the safe generic message below.
  }
  return [401, 403].includes(status) ? ACCESS_MESSAGE : SERVICE_MESSAGE;
}

export async function createJob(signal?: AbortSignal): Promise<{ job_id: string; expires_at: string }> {
  return request("/api/v1/jobs", { method: "POST", body: "{}", signal });
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
    xhr.setRequestHeader("Content-Type", file.type || "text/csv");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
      const percent = total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : 0;
      onProgress({ loaded: Math.min(event.loaded, total), total, percent });
    };
    xhr.onload = () => {
      removeAbortListener();
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error(SERVICE_MESSAGE)); }
      }
      else reject(new Error(uploadErrorMessage(xhr.responseText, xhr.status)));
    };
    xhr.onerror = () => { removeAbortListener(); reject(new Error(SERVICE_MESSAGE)); };
    xhr.onabort = () => { removeAbortListener(); reject(new DOMException("Upload canceled", "AbortError")); };
    signal?.addEventListener("abort", abortUpload, { once: true });
    if (signal?.aborted) {
      abortUpload();
      return;
    }
    xhr.send(file);
  });
}

export const getJob = (jobId: string, signal?: AbortSignal) => request<Job>(`/api/v1/jobs/${jobId}`, { signal });
export const setWorkflow = (jobId: string, workflow: Workflow) => request<Job>(`/api/v1/jobs/${jobId}/workflow`, { method: "PUT", body: JSON.stringify({ workflow }) });
export const setMapping = (jobId: string, mapping: MappingConfig) => request<Job>(`/api/v1/jobs/${jobId}/mapping`, { method: "PUT", body: JSON.stringify(mapping) });
export const inspectMappingBlanks = (jobId: string, mapping: MappingConfig, signal?: AbortSignal) => request<MappingBlankReport>(`/api/v1/jobs/${jobId}/mapping/blank-cells`, { method: "POST", body: JSON.stringify(mapping), signal });
export const setPleadingSettings = (jobId: string, settings: PleadingSettings) => request<Job>(`/api/v1/jobs/${jobId}/pleading-settings`, { method: "PUT", body: JSON.stringify(settings) });
export const readyForReview = (jobId: string, acknowledgedIssueCodes: string[]) => request<Job>(`/api/v1/jobs/${jobId}/review`, { method: "POST", body: JSON.stringify({ acknowledged_issue_codes: acknowledgedIssueCodes }) });
export const getPreview = (jobId: string, signal?: AbortSignal) => request<Preview>(`/api/v1/jobs/${jobId}/preview?limit=5`, { signal });
export const finalizeJob = (jobId: string, outputFilename: string, acknowledgedIssueCodes: string[], reviewToken: string) => request<Job>(`/api/v1/jobs/${jobId}/finalize`, { method: "POST", body: JSON.stringify({ output_filename: outputFilename, acknowledged_issue_codes: acknowledgedIssueCodes, review_token: reviewToken }) });
export type DeleteOutcome = "deleted" | "pending";

export async function deleteJob(jobId: string): Promise<DeleteOutcome> {
  const response = await fetch(`/api/v1/jobs/${jobId}`, { method: "DELETE" }).catch(() => {
    throw new Error(SERVICE_MESSAGE);
  });
  if (response.status === 202) return "pending";
  if (response.status === 204 || response.status === 404) return "deleted";
  throw new Error("The job could not be deleted. Try again or contact the service operator.");
}
