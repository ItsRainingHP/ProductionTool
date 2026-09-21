/**
 * @file Validation summary and warning-acknowledgement controls.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { Checkbox, Column, Heading, Icon, Row, Tag, Text } from "@once-ui-system/core";
import type { Analysis, Issue } from "../../lib/types";
import { blockingIssues, issueOccurrenceCount, validationTone, warningIssues } from "../../lib/validation";

type ValidationResultsProps = {
  analysis: Analysis;
  acknowledged?: string[];
  onToggle?: (code: string) => void;
  detailed?: boolean;
};

function IssueLocation({ issue }: { issue: Issue }) {
  const details = [
    issue.row ? `First affected row: ${issue.row}` : null,
    issue.column ? `Column: ${issue.column}` : null,
    `${issue.count.toLocaleString()} ${issue.count === 1 ? "occurrence" : "occurrences"}`,
  ].filter(Boolean);
  return <Text variant="body-default-xs" onBackground="neutral-weak">{details.join(" · ")}</Text>;
}

export function ValidationResults({ analysis, acknowledged = [], onToggle, detailed = true }: ValidationResultsProps) {
  const tone = validationTone(analysis);
  const warnings = warningIssues(analysis);
  const blockers = blockingIssues(analysis);
  const shownIssues = blockers.length ? blockers : warnings;
  const occurrenceCount = issueOccurrenceCount(shownIssues);
  const title = tone === "valid" ? "CSV ready" : tone === "warning" ? "Review required" : "CSV cannot be processed";
  const explanation = tone === "valid"
    ? "The file is readable and no malformed rows were found."
    : tone === "warning"
      ? `${warnings.length.toLocaleString()} recoverable ${warnings.length === 1 ? "issue" : "issues"} with ${occurrenceCount.toLocaleString()} affected ${occurrenceCount === 1 ? "occurrence" : "occurrences"}. Review and acknowledge each issue before creating output.`
      : `${blockers.length.toLocaleString()} blocking ${blockers.length === 1 ? "issue prevents" : "issues prevent"} safe processing. Replace this file to continue.`;
  const background = tone === "valid" ? "success-alpha-weak" : tone === "warning" ? "warning-alpha-weak" : "danger-alpha-weak";
  const border = tone === "valid" ? "success-alpha-medium" : tone === "warning" ? "warning-alpha-medium" : "danger-alpha-medium";
  const iconColor = tone === "valid" ? "success-medium" : tone === "warning" ? "warning-medium" : "danger-medium";
  const tagVariant = tone === "valid" ? "success" : tone === "warning" ? "warning" : "danger";

  return (
    <Column
      fillWidth
      gap="16"
      padding="20"
      radius="l"
      background={background}
      border={border}
      role={tone === "blocked" ? "alert" : "status"}
      aria-live="polite"
      className="validation-results"
    >
      <Row fillWidth gap="12" vertical="start">
        <Row center width="40" height="40" radius="full" background={background} className="validation-icon">
          <Icon name={tone === "valid" ? "check" : "warning"} onBackground={iconColor} />
        </Row>
        <Column gap="4" flex={1}>
          <Row gap="8" vertical="center" wrap>
            <Heading as="h2" variant="heading-strong-m">{title}</Heading>
            <Tag variant={tagVariant}>{tone === "valid" ? "Valid" : tone === "warning" ? "Warnings" : "Blocked"}</Tag>
          </Row>
          <Text variant="body-default-s">{explanation}</Text>
        </Column>
      </Row>

      {detailed && shownIssues.length > 0 && (
        <Column gap="12">
          {shownIssues.map((issue) => {
            const checked = acknowledged.includes(issue.code);
            return (
              <Column key={`${issue.code}-${issue.column ?? ""}`} gap="8" padding="16" radius="m" background="surface" border="neutral-alpha-weak" className="validation-issue">
                <Row fillWidth gap="8" vertical="center" wrap>
                  <Tag variant={issue.severity === "warning" ? "warning" : "danger"}>{issue.severity === "fatal" ? "Fatal" : issue.severity === "error" ? "Error" : "Warning"}</Tag>
                  <Text variant="label-strong-s">{issue.message}</Text>
                </Row>
                <IssueLocation issue={issue} />
                {issue.overrideable && onToggle && (
                  <Checkbox
                    label="I understand how this issue affects the output"
                    isChecked={checked}
                    onToggle={() => onToggle(issue.code)}
                  />
                )}
              </Column>
            );
          })}
        </Column>
      )}
    </Column>
  );
}
