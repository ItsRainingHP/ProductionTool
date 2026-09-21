/**
 * @file Navigable progress indicator for the production workflow.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { Button, Row, Text } from "@once-ui-system/core";

export const steps = [
  { key: "upload", label: "Upload" },
  { key: "data", label: "Data" },
  { key: "advanced", label: "Advanced" },
  { key: "review", label: "Review" },
  { key: "download", label: "Download" },
] as const;

export type StepKey = (typeof steps)[number]["key"];

export function Stepper({ active, onNavigate }: { active: StepKey; onNavigate: (step: StepKey) => void }) {
  const activeIndex = steps.findIndex((step) => step.key === active);
  return (
    <Row as="nav" aria-label="Production steps" fillWidth horizontal="center" className="stepper" overflowX="auto">
      {steps.map((step, index) => {
        const complete = index < activeIndex;
        const current = index === activeIndex;
        return (
          <Row key={step.key} vertical="center" gap="8" className="stepper-item">
            <Button
              type="button"
              variant="ghost"
              size="s"
              className={`step-button ${complete ? "is-complete" : ""} ${current ? "is-current" : ""}`}
              aria-current={current ? "step" : undefined}
              disabled={index > activeIndex}
              onClick={() => complete && onNavigate(step.key)}
            >
              <Text as="span" variant="label-strong-m" className="step-label">{step.label}</Text>
              <span className="step-number">{complete ? "✓" : index + 1}</span>
            </Button>
            {index < steps.length - 1 && <span className={`step-line ${complete ? "is-complete" : ""}`} />}
          </Row>
        );
      })}
    </Row>
  );
}
