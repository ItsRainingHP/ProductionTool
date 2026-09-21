/**
 * @file Accessible workflow choice cards for the Data step.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { Card, Grid, Heading, Icon, Row, Text } from "@once-ui-system/core";
import type { KeyboardEvent } from "react";
import type { Workflow } from "@/lib/types";

const WORKFLOWS = [
  {
    value: "rfp_ranges",
    title: "RFP / Pleading Ranges",
    description: "Create a formatted text list of contiguous Bates ranges grouped by request.",
    icon: "document",
  },
  {
    value: "privilege_log",
    title: "Privilege Log",
    description: "Map, combine, rename, and transform fields into a new log.",
    icon: "chevronsLeftRight",
  },
] as const satisfies ReadonlyArray<{ value: Workflow; title: string; description: string; icon: "document" | "chevronsLeftRight" }>;

export function WorkflowSelector({ value, onChange }: { value: Workflow | null; onChange: (workflow: Workflow) => void }) {
  const focusOption = (workflow: Workflow) => {
    window.setTimeout(() => document.querySelector<HTMLElement>(`[data-workflow-option="${workflow}"]`)?.focus(), 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const keyDirections: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let nextIndex: number | null = null;
    if (event.key in keyDirections) nextIndex = (index + keyDirections[event.key] + WORKFLOWS.length) % WORKFLOWS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = WORKFLOWS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = WORKFLOWS[nextIndex].value;
    onChange(next);
    focusOption(next);
  };

  return (
    <div role="radiogroup" aria-label="Output type" className="workflow-group">
      <Grid columns="2" gap="16" fillWidth s={{ columns: 1 }}>
        {WORKFLOWS.map((workflow, index) => (
          <Card
            key={workflow.value}
            className={`workflow-card ${value === workflow.value ? "is-selected" : ""}`}
            role="radio"
            aria-checked={value === workflow.value}
            tabIndex={value === workflow.value || (!value && index === 0) ? 0 : -1}
            data-workflow-option={workflow.value}
            onClick={() => onChange(workflow.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onChange(workflow.value);
                return;
              }
              handleKeyDown(event, index);
            }}
          >
            <Row center width="48" height="48" radius="m" background="brand-alpha-weak"><Icon name={workflow.icon} onBackground="brand-medium" /></Row>
            <Heading as="h2" variant="heading-strong-m">{workflow.title}</Heading>
            <Text variant="body-default-s" onBackground="neutral-weak">{workflow.description}</Text>
            <span className="workflow-check" aria-hidden>{value === workflow.value ? "✓" : ""}</span>
          </Card>
        ))}
      </Grid>
    </div>
  );
}
