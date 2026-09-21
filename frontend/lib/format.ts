/**
 * @file User-facing byte, filename, and platform-confidence formatting helpers.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import type { Analysis, Workflow } from "./types";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

export function defaultOutputFilename(source: string, workflow: Workflow | null): string {
  const stem = source.replace(/\.csv$/i, "") || "production";
  return `${stem}_${workflow === "rfp_ranges" ? "rfp_ranges" : "privilege_log"}`;
}

function platformName(platform: Analysis["platform"]): string {
  if (platform === "logikcull") return "Logikcull";
  if (platform === "everlaw") return "Everlaw";
  return "Unknown";
}

export function platformConfidenceSentence(analysis: Pick<Analysis, "platform" | "platform_confidence">): string {
  if (analysis.platform === "unknown") {
    return `Source platform could not be identified confidently (${analysis.platform_confidence}% confidence).`;
  }
  return `CSV structure most closely matches ${platformName(analysis.platform)} (${analysis.platform_confidence}% confidence).`;
}

export function platformConfidenceLabel(analysis: Pick<Analysis, "platform" | "platform_confidence">): string {
  return analysis.platform === "unknown"
    ? `Unknown · ${analysis.platform_confidence}%`
    : `Likely ${platformName(analysis.platform)} · ${analysis.platform_confidence}%`;
}
