"use client";

import dynamic from "next/dynamic";
import { HeaderSymbol } from "@/components/header-symbol";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button, Column, Dialog, Row, Text } from "@once-ui-system/core";
import { ONBOARDING_KEY, chapterLabels, parseOnboarding, readOnboarding, tourTips, writeOnboarding,
  type OnboardingState, type Persistence, type TourChapter, type TourScreen, type TourTip } from "@/lib/onboarding";

const TourRunner = dynamic(() => import("./tour-runner"), { ssr: false });
interface Run { chapter: TourChapter; tips: TourTip[]; initialIndex: number }
interface TourContext {
  register: (screen: TourScreen | null) => void;
  openHelp: () => void;
}
const Context = createContext<TourContext | null>(null);

export function useTourScreen(screen: TourScreen) {
  const register = useContext(Context)?.register;
  const { chapter, ready, deferAutomatic, blocked, advisories, maxUpload, retentionHours, isTextOutput } = screen;
  useEffect(() => {
    register?.({ chapter, ready, deferAutomatic, blocked, advisories, maxUpload, retentionHours, isTextOutput });
    return () => register?.(null);
  }, [register, chapter, ready, deferAutomatic, blocked, advisories, maxUpload, retentionHours, isTextOutput]);
}

export function TourHelp() {
  const tour = useContext(Context);
  return tour ? <button type="button" data-tour-help className="help-icon-button"
    onClick={tour.openHelp} aria-label="Help and guided tour" title="Help and guided tour" aria-haspopup="dialog">
    <HeaderSymbol>?</HeaderSymbol>
  </button> : null;
}

function canShowTour(): boolean {
  return document.visibilityState !== "hidden"
    && !Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
      .some((dialog) => !dialog.matches(".tour-card") && !dialog.querySelector(".tour-dialog"))
    && !(document.activeElement instanceof HTMLElement && document.activeElement.matches("input, textarea, select, [contenteditable=true]"));
}

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const latest = useRef<OnboardingState | null>(null);
  const [persistence, setPersistence] = useState<Persistence>("local");
  const [screen, setScreen] = useState<TourScreen | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [help, setHelp] = useState(false);
  const [safe, setSafe] = useState(false);
  const dragging = useRef(false);
  const register = useCallback((value: TourScreen | null) => setScreen(value), []);
  const commit = useCallback((update: (value: OnboardingState) => OnboardingState) => {
    if (!latest.current) return;
    const next = update(latest.current);
    latest.current = next;
    setPersistence(writeOnboarding(next));
    setState(next);
  }, []);

  useEffect(() => {
    const check = () => setSafe(!dragging.current && canShowTour());
    // Wait for the initial screen to mount before reading browser state and
    // measuring whether an introduction can open without interrupting input.
    const initialFrame = requestAnimationFrame(() => {
      const loaded = readOnboarding();
      latest.current = loaded.state;
      setState(loaded.state);
      setPersistence(loaded.persistence);
      check();
    });
    const dragStart = () => { dragging.current = true; setSafe(false); };
    const dragEnd = () => { dragging.current = false; check(); };
    const storage = (event: StorageEvent) => {
      if (event.key !== ONBOARDING_KEY) return;
      const external = parseOnboarding(event.newValue);
      if (!external) return;
      // Merge completed sections so another tab cannot erase known progress.
      const chapters = { ...external.chapters };
      for (const [id, progress] of Object.entries(latest.current?.chapters ?? {})) {
        if (progress.completed) chapters[id as TourChapter] = progress;
      }
      latest.current = { ...external, chapters };
      setState(latest.current);
      setRun(null);
      setHelp(false);
      // A storage event never opens an experience in an inactive tab.
      setSafe(false);
    };
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", check);
    document.addEventListener("visibilitychange", check);
    document.addEventListener("dragstart", dragStart);
    document.addEventListener("dragend", dragEnd);
    document.addEventListener("drop", dragEnd);
    window.addEventListener("storage", storage);
    return () => {
      cancelAnimationFrame(initialFrame);
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", check);
      document.removeEventListener("visibilitychange", check);
      document.removeEventListener("dragstart", dragStart);
      document.removeEventListener("dragend", dragEnd);
      document.removeEventListener("drop", dragEnd);
      window.removeEventListener("storage", storage);
    };
  }, []);

  const start = useCallback((chapter: TourChapter, replay = false) => {
    if (!screen?.ready) return;
    const tips = tourTips(chapter, screen);
    const saved = latest.current?.chapters[chapter]?.nextTipId;
    const index = replay ? 0 : Math.max(0, tips.findIndex((tip) => tip.id === saved));
    setHelp(false);
    setRun({ chapter, tips, initialIndex: index });
  }, [screen]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const owner = run?.chapter === "mapping-details" ? "advanced-privilege" : run?.chapter === "format-details" ? "advanced-rfp" : run?.chapter;
      if (run && (!screen?.ready || owner !== screen.chapter)) {
        setRun(null);
        return;
      }
      if (state?.preference === "enabled" && screen?.ready && !screen.deferAutomatic && !run && !help && safe
        && !state.chapters[screen.chapter]?.completed) start(screen.chapter);
    });
    return () => cancelAnimationFrame(frame);
  }, [screen, state, run, help, safe, start]);

  const pause = useCallback(() => {
    commit((value) => ({ ...value, preference: "paused" }));
    setRun(null);
  }, [commit]);
  const progress = useCallback((id: string) => {
    const saved = run && latest.current?.chapters[run.chapter];
    if (saved?.nextTipId === id && !saved.completed) return;
    if (run) commit((value) => ({ ...value, chapters: { ...value.chapters, [run.chapter]: { completed: false, nextTipId: id } } }));
  }, [run, commit]);
  const finish = useCallback(() => {
    if (run) commit((value) => ({ ...value, chapters: { ...value.chapters, [run.chapter]: { completed: true, nextTipId: null } } }));
    setRun(null);
  }, [run, commit]);
  const enable = () => {
    commit((value) => ({ ...value, preference: "enabled" }));
    setHelp(false);
    if (screen?.ready && !latest.current?.chapters[screen.chapter]?.completed) start(screen.chapter);
  };
  const skip = () => { commit((value) => ({ ...value, preference: "skipped" })); };
  const context = useMemo(() => ({ register, openHelp: () => setHelp(true) }), [register]);
  const welcome = state?.preference === "new" && !help && safe && screen?.ready && !screen.deferAutomatic;

  return <Context.Provider value={context}>
    {children}
    {welcome && <Dialog isOpen title="Welcome to the Production Tool" onClose={skip} closeOnClickaway={false} className="tour-dialog">
      <Column gap="24">
        <Text variant="body-default-m">Turn Everlaw or Logikcull CSV exports into pleading ranges or privilege logs. Take a short guided introduction as you process your first file.</Text>
        <Text variant="body-default-s" onBackground="neutral-weak">A few tips appear on each screen. You can pause anytime and return through Help.</Text>
        <Row gap="12" wrap><Button onClick={enable}>Start tour</Button><Button variant="secondary" onClick={skip}>Skip tour</Button></Row>
      </Column>
    </Dialog>}
    {help && <Dialog isOpen title="Help and guided tour" onClose={() => setHelp(false)} closeOnClickaway={false} className="tour-dialog">
      <Column gap="16">
        <Text variant="body-default-m">Short introductions explain each screen while you work. Your progress stays in this browser.</Text>
        <Row gap="12" wrap>
          <Button onClick={enable}>{state?.preference === "enabled" ? "Continue tour" : "Resume tour"}</Button>
          {screen && <Button variant="secondary" disabled={!screen.ready} onClick={() => start(screen.chapter, true)}>Replay this screen</Button>}
        </Row>
        {screen && <Text variant="body-default-s" onBackground="neutral-weak">Current screen: {chapterLabels[screen.chapter]}{!screen.ready ? " · Available after this operation finishes" : ""}</Text>}
        {screen?.chapter === "advanced-privilege" && <Button variant="secondary" disabled={!screen.ready} onClick={() => start("mapping-details", true)}>Explain mapping options</Button>}
        {screen?.chapter === "advanced-rfp" && <Button variant="secondary" disabled={!screen.ready} onClick={() => start("format-details", true)}>Explain text formatting</Button>}
        {persistence !== "local" && <Text variant="body-default-s" onBackground="neutral-weak">Tour progress can only be remembered {persistence === "session" ? "in this tab for this browser session" : "until this page is reloaded"} because browser storage is unavailable.</Text>}
      </Column>
    </Dialog>}
    {run && screen?.ready && <TourRunner key={run.chapter} {...run} onProgress={progress} onFinish={finish} onPause={pause} />}
  </Context.Provider>;
}
