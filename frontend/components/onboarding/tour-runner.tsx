"use client";

import { useCallback, useEffect, useMemo } from "react";
import { Button } from "@once-ui-system/core";
import { ACTIONS, EVENTS, Joyride, STATUS, type EventData, type TooltipRenderProps } from "react-joyride";
import { chapterLabels, type TourChapter, type TourTip } from "@/lib/onboarding";

function TourTooltip({ backProps, closeProps, primaryProps, skipProps, tooltipProps, index, isLastStep, size, step }: TooltipRenderProps) {
  return (
    <section {...tooltipProps} aria-label={String(step.title)} aria-describedby="tour-description" className="tour-card">
      <div className="tour-card-heading">
        <p className="tour-eyebrow">{String(step.data?.label)} · Tip {index + 1} of {size}</p>
        <button {...closeProps} className="tour-close" aria-label="Pause and close tour" title="Pause and close tour">×</button>
      </div>
      <h2>{step.title}</h2>
      <p id="tour-description" className="tour-description">{step.content}</p>
      <div className="tour-card-footer">
        <button {...skipProps} className="tour-pause" aria-label="Pause tour" title="Pause tour">Pause tour</button>
        <div className="tour-navigation">
          {index > 0 && <Button {...backProps} size="s" variant="secondary">Back</Button>}
          <Button {...primaryProps} size="s" aria-label={isLastStep ? "Got it" : "Next tip"} title={isLastStep ? "Got it" : "Next tip"}>{isLastStep ? "Got it" : "Next tip"}</Button>
        </div>
      </div>
    </section>
  );
}

export interface TourRunnerProps {
  chapter: TourChapter;
  tips: TourTip[];
  initialIndex: number;
  onProgress: (id: string) => void;
  onFinish: () => void;
  onPause: () => void;
}

export default function TourRunner({ chapter, tips, initialIndex, onProgress, onFinish, onPause }: TourRunnerProps) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const steps = useMemo(() => tips.map((tip) => ({ target: tip.target, title: tip.title, content: tip.content,
    data: { id: tip.id, label: chapterLabels[chapter] }, placement: "bottom" as const })), [chapter, tips]);

  useEffect(() => {
    // Escape must also work while Joyride is positioning the next tooltip.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onPause();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [onPause]);

  useEffect(() => {
    // The spotlight is informational. Exclude underlying controls from all input,
    // including assistive navigation, while preserving their prior inert state.
    const surfaces = Array.from(document.querySelectorAll<HTMLElement>("main, .app-header, .app-footer"));
    const previous = surfaces.map((element) => element.inert);
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surfaces.forEach((element) => { element.inert = true; });
    return () => {
      surfaces.forEach((element, index) => { element.inert = previous[index]; });
      // Joyride also restores focus during its own cleanup. Restore after those
      // callbacks so a removed welcome button cannot leave focus on the body.
      queueMicrotask(() => {
        if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
        const destination = focused?.isConnected && focused !== document.body ? focused
          : document.querySelector<HTMLElement>("#step-title") ?? document.querySelector<HTMLElement>("[data-tour-help]");
        destination?.focus({ preventScroll: true });
      });
    };
  }, []);

  const onEvent = useCallback((event: EventData) => {
    if (event.action === ACTIONS.CLOSE || event.action === ACTIONS.SKIP
      || event.type === EVENTS.TARGET_NOT_FOUND || event.type === EVENTS.ERROR) {
      onPause();
    } else if (event.type === EVENTS.TOUR_END && event.status === STATUS.FINISHED) {
      onFinish();
    } else if (event.type === EVENTS.TOOLTIP || event.type === EVENTS.STEP_BEFORE) {
      onProgress(String(event.step.data?.id));
    }
  }, [onPause, onFinish, onProgress]);

  return <Joyride run continuous scrollToFirstStep initialStepIndex={initialIndex} steps={steps}
    tooltipComponent={TourTooltip} onEvent={onEvent} loaderComponent={null}
    locale={{ back: "Back", close: "Pause and close tour", last: "Got it", next: "Next tip", skip: "Pause tour", open: "Open tour" }}
    options={{ skipBeacon: true, blockTargetInteraction: true, overlayClickAction: false, dismissKeyAction: false,
      showProgress: true, targetWaitTimeout: 1200, scrollOffset: 120, scrollDuration: reducedMotion ? 0 : 200,
      spotlightPadding: 6, spotlightRadius: 12, zIndex: 1000, width: "min(380px, calc(100vw - 32px))",
      backgroundColor: "var(--page-background)", textColor: "var(--neutral-on-background-strong)",
      arrowColor: "var(--page-background)", overlayColor: "rgba(0, 0, 0, 0.62)" }}
    styles={{ spotlight: { stroke: "var(--brand-solid-strong)", strokeWidth: 2 } }}
    floatingOptions={{ flipOptions: { padding: 16 }, shiftOptions: { padding: 16, crossAxis: true } }} />;
}
