/**
 * @file Step 1 progress display for large CSV transfer and analysis.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

"use client";

import { Button, Column, Heading, ProgressBar, Row, Text } from "@once-ui-system/core";
import { formatBytes } from "../../lib/format";

type UploadStage = "preparing" | "uploading" | "analyzing";

interface UploadProgressProps {
  file: { name: string; size: number } | null;
  stage: UploadStage;
  percent: number;
  transferredBytes?: number;
  transferBytes?: number;
  phase: string;
  onCancel?: () => void;
}

export function UploadProgress({
  file,
  stage,
  percent,
  transferredBytes = 0,
  transferBytes = 0,
  phase,
  onCancel,
}: UploadProgressProps) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  const headline = stage === "analyzing" ? "Analyzing CSV data" : "Uploading CSV data";
  const status = stage === "preparing"
    ? "Preparing a temporary workspace…"
    : stage === "uploading" && safePercent < 100
      ? `${formatBytes(transferredBytes)} of ${formatBytes(transferBytes || file?.size || 0)} transferred`
      : stage === "uploading"
        ? "Upload transferred. The server is validating the file…"
        : phase;

  return (
    <Column gap="24">
      <Column gap="8">
        <Text variant="label-default-s" onBackground="brand-medium">STEP 1 OF 5</Text>
        <Heading id="step-title" tabIndex={-1} as="h1" variant="display-strong-s">{headline}</Heading>
        <Text variant="body-default-m" onBackground="neutral-weak">
          Keep this page open while the file is transferred and checked.
        </Text>
      </Column>
      <Column
        fillWidth
        background="surface"
        border="neutral-alpha-weak"
        radius="l"
        padding="24"
        gap="20"
        className="upload-progress-panel"
      >
        {file && (
          <Row fillWidth horizontal="between" gap="16" wrap>
            <Column gap="4" minWidth={0}>
              <Text variant="label-default-xs" onBackground="neutral-weak">SELECTED FILE</Text>
              <Text variant="label-strong-s" className="upload-file-name">{file.name}</Text>
            </Column>
            <Text variant="label-strong-s">{formatBytes(file.size)}</Text>
          </Row>
        )}
        <ProgressBar value={safePercent} label labelPosition="top" className="large-upload-progress" />
        <Row fillWidth horizontal="between" gap="16" wrap role="status" aria-live="polite" aria-atomic="true">
          <Text variant="label-strong-s">{status}</Text>
          <Text variant="label-strong-s">{safePercent}%</Text>
        </Row>
        {stage === "analyzing" && (
          <Text variant="body-default-s" onBackground="neutral-weak">
            Transfer is complete. Step 2 will open automatically after structural validation finishes.
          </Text>
        )}
        {onCancel && <Button variant="danger" onClick={onCancel}>Cancel and remove workspace</Button>}
      </Column>
    </Column>
  );
}
