/**
 * @file Unit tests for user-facing formatting helpers.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { describe, expect, it } from "vitest";
import { defaultOutputFilename, formatBytes, platformConfidenceLabel, platformConfidenceSentence } from "./format";

describe("formatBytes", () => {
  it("formats upload and output sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.00 KiB");
    expect(formatBytes(500 * 1024 * 1024)).toBe("500.0 MiB");
  });
});

describe("defaultOutputFilename", () => {
  it("uses workflow-specific suffixes", () => {
    expect(defaultOutputFilename("matter.csv", "rfp_ranges")).toBe("matter_rfp_ranges");
    expect(defaultOutputFilename("matter.CSV", "privilege_log")).toBe("matter_privilege_log");
  });
});

describe("platform confidence copy", () => {
  it("describes a known platform as the closest structural match", () => {
    const analysis = { platform: "logikcull" as const, platform_confidence: 92 };
    expect(platformConfidenceSentence(analysis)).toBe("CSV structure most closely matches Logikcull (92% confidence).");
    expect(platformConfidenceLabel(analysis)).toBe("Likely Logikcull · 92%");
  });

  it("names Everlaw when its header pattern matches", () => {
    const analysis = { platform: "everlaw" as const, platform_confidence: 86 };
    expect(platformConfidenceSentence(analysis)).toContain("Everlaw (86% confidence)");
    expect(platformConfidenceLabel(analysis)).toContain("Everlaw");
  });

  it("falls back to Unknown for an unrecognized future platform value", () => {
    const analysis = { platform: "future-vendor" as "unknown", platform_confidence: 1 };
    expect(platformConfidenceSentence(analysis)).toContain("Unknown (1% confidence)");
  });

  it.each([0, 42, 59])("does not name a platform for an unknown score of %i", (platform_confidence) => {
    const analysis = { platform: "unknown" as const, platform_confidence };
    expect(platformConfidenceSentence(analysis)).toBe(`Source platform could not be identified confidently (${platform_confidence}% confidence).`);
    expect(platformConfidenceLabel(analysis)).toBe(`Unknown · ${platform_confidence}%`);
  });
});
