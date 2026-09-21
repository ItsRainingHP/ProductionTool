/**
 * @file Client-side upload checks and derived CSV validation state.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import type { Analysis, Issue } from "./types";

const ALLOWED_CSV_MIME_TYPES = new Set([
  "",
  "application/csv",
  "application/octet-stream",
  "application/vnd.ms-excel",
  "text/csv",
  "text/plain",
]);

export type ValidationTone = "valid" | "warning" | "blocked";

export function warningIssues(analysis: Analysis | null | undefined): Issue[] {
  return analysis?.issues.filter((issue) => issue.severity === "warning") ?? [];
}

export function blockingIssues(analysis: Analysis | null | undefined): Issue[] {
  return analysis?.issues.filter((issue) => issue.severity === "error" || issue.severity === "fatal") ?? [];
}

export function validationTone(analysis: Analysis | null | undefined): ValidationTone {
  if (blockingIssues(analysis).length) return "blocked";
  if (warningIssues(analysis).length) return "warning";
  return "valid";
}

export function warningsAcknowledged(analysis: Analysis | null | undefined, acknowledged: string[]): boolean {
  return warningIssues(analysis).every((issue) => acknowledged.includes(issue.code));
}

export function issueOccurrenceCount(issues: Issue[]): number {
  return issues.reduce((total, issue) => total + issue.count, 0);
}

export function clientFileError(
  file: Pick<File, "name" | "size" | "type">,
  maxBytes: number,
  allowedTypes: Set<string> = ALLOWED_CSV_MIME_TYPES,
): string | null {
  if (!file.name.toLocaleLowerCase().endsWith(".csv")) return "Choose a file with a .csv extension.";
  if (file.size === 0) return "Choose a non-empty CSV file.";
  if (file.size > maxBytes) return `This file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`;
  if (!allowedTypes.has(file.type.toLocaleLowerCase())) {
    return "This file reports an unsupported type. Choose a CSV text file.";
  }
  return null;
}
