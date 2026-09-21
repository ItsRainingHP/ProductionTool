/**
 * @file Aggregate, non-blocking personal-data findings shown during review.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { Column, Heading, Icon, Row, Tag, Text } from "@once-ui-system/core";
import type { PersonalDataFinding } from "@/lib/types";

const LABELS: Record<PersonalDataFinding["category"], string> = {
  ssn: "Social Security numbers",
  date_of_birth: "Dates of birth",
  personal_email: "Personal email domains",
  single_word_name: "Possible one-word names or usernames",
};

export function PersonalDataNotice({ findings }: { findings: PersonalDataFinding[] }) {
  if (!findings.length) return null;

  return (
    <Column
      fillWidth
      gap="16"
      padding="20"
      radius="l"
      background="warning-alpha-weak"
      border="warning-alpha-medium"
      role="status"
      aria-live="polite"
      className="personal-data-notice"
    >
      <Row fillWidth gap="12" vertical="start">
        <Row center width="40" height="40" radius="full" background="warning-alpha-weak" className="validation-icon">
          <Icon name="warning" onBackground="warning-medium" />
        </Row>
        <Column gap="4" flex={1}>
          <Row gap="8" vertical="center" wrap>
            <Heading as="h2" variant="heading-strong-m">Potential personal data detected</Heading>
            <Tag variant="warning">Advisory</Tag>
          </Row>
          <Text variant="body-default-s">
            Review these fields before sharing the output. This notice does not change the source CSV or prevent you from continuing.
          </Text>
        </Column>
      </Row>
      <Column gap="8">
        {findings.map((finding) => (
          <Row key={finding.category} fillWidth horizontal="between" vertical="center" gap="12" wrap padding="12" radius="m" background="surface" border="neutral-alpha-weak">
            <Column gap="2">
              <Text variant="label-strong-s">{LABELS[finding.category]}</Text>
              <Text variant="body-default-xs" onBackground="neutral-weak">Columns: {finding.columns.join(", ")}</Text>
            </Column>
            <Tag variant="warning">{finding.count.toLocaleString()} {finding.count === 1 ? "occurrence" : "occurrences"}</Tag>
          </Row>
        ))}
      </Column>
    </Column>
  );
}
