/**
 * @file RFP and pleading output separator and conjunction settings.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { Button, Checkbox, Column, Heading, Row, Text } from "@once-ui-system/core";
import type { PleadingSettings } from "@/lib/types";

export const DEFAULT_PLEADING_SETTINGS: PleadingSettings = {
  delimiter: "comma",
  include_and: true,
};

const DELIMITERS: Array<{ value: PleadingSettings["delimiter"]; label: string }> = [
  { value: "comma", label: "Comma" },
  { value: "semicolon", label: "Semicolon" },
  { value: "pipe", label: "Pipe" },
  { value: "newline", label: "New line" },
];

type PleadingSettingsEditorProps = {
  settings: PleadingSettings;
  onChange: (settings: PleadingSettings) => void;
};

export function PleadingSettingsEditor({ settings, onChange }: PleadingSettingsEditorProps) {
  return (
    <Column fillWidth background="surface" border="neutral-alpha-weak" radius="l" padding="24" gap="16">
      <Column gap="4">
        <Heading as="h2" variant="heading-strong-m">Text formatting</Heading>
        <Text variant="body-default-s" onBackground="neutral-weak">Choose how Bates ranges are separated beneath each RFP heading.</Text>
      </Column>
      <Column gap="8">
        <Text variant="label-strong-s">Delimiter</Text>
        <Row gap="8" wrap>
          {DELIMITERS.map((delimiter) => (
            <Button
              key={delimiter.value}
              size="s"
              variant={settings.delimiter === delimiter.value ? "primary" : "secondary"}
              aria-pressed={settings.delimiter === delimiter.value}
              onClick={() => onChange({ ...settings, delimiter: delimiter.value })}
            >
              {delimiter.label}
            </Button>
          ))}
        </Row>
      </Column>
      <Checkbox
        label="Include ‘and’ before the final range"
        isChecked={settings.include_and}
        onToggle={() => onChange({ ...settings, include_and: !settings.include_and })}
      />
    </Column>
  );
}
