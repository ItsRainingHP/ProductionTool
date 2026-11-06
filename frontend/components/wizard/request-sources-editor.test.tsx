import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Providers } from "../../app/providers";
import type { Analysis, Job, PleadingSettings } from "../../lib/types";
import { initialPleadingSettings, RequestSourcesEditor } from "./request-sources-editor";

const analysis = {
  headers: ["Begin Bates", "End Bates", "RFPs: RFP 23 (2): Calendars", "Matter: Emails", "Privilege: Withheld"],
  begin_bates_header: "Begin Bates", end_bates_header: "End Bates",
  request_candidates: [
    { column: "RFPs: RFP 23 (2): Calendars", category: "RFPs", code: "RFP 23 (2): Calendars",
      layout: "individual", input_separator: "auto", suggested: true, samples: ["RFP 23 (2): Calendars"] },
    { column: "Matter: Emails", category: "Matter", code: "Emails", layout: "individual", input_separator: "auto",
      suggested: false, samples: ["Emails"] },
    { column: "Privilege: Withheld", category: "Privilege", code: "Withheld", layout: "individual",
      input_separator: "auto", suggested: false, samples: [] },
  ],
} as Analysis;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});
afterEach(cleanup);

it("suggests request sources and leaves arbitrary and privilege codes available", () => {
  const initial = initialPleadingSettings({ analysis, pleading_settings: null } as Job);
  function Editor() {
    const [settings, setSettings] = useState<PleadingSettings>(initial);
    return <RequestSourcesEditor analysis={analysis} settings={settings} onChange={setSettings} />;
  }
  render(<Providers><Editor /></Providers>);
  expect(screen.getByRole("checkbox", { name: "RFP 23 (2): Calendars" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Emails" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Withheld" })).not.toBeChecked();
  expect(screen.getByText("Pleading heading: RFP 23 (2): Calendars")).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox", { name: "Emails" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Source layout for Matter: Emails" }), {
    target: { value: "category" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Input code separator for Matter: Emails" }), {
    target: { value: "semicolon" },
  });
  expect(screen.getByRole("combobox", { name: "Input code separator for Matter: Emails" })).toHaveValue("semicolon");
  fireEvent.click(screen.getByRole("checkbox", { name: "Emails" }));
  expect(screen.queryByRole("combobox", { name: "Source layout for Matter: Emails" })).not.toBeInTheDocument();
});

it("keeps saved sources, supports old jobs, and explains an empty selection", () => {
  const settings: PleadingSettings = { delimiter: "comma", include_and: true, request_sources: [] };
  expect(initialPleadingSettings({ analysis, pleading_settings: settings } as Job)).toBe(settings);
  const old = { analysis: { ...analysis, request_candidates: undefined }, pleading_settings: null } as Job;
  expect(initialPleadingSettings(old)).toEqual({ delimiter: "comma", include_and: true });
  expect(initialPleadingSettings({ ...old, analysis: { ...analysis, request_candidates: [] } } as Job)
    .request_sources?.map((source) => source.column)).toEqual(["RFPs: RFP 23 (2): Calendars"]);
  render(<Providers><RequestSourcesEditor analysis={old.analysis!} settings={settings} onChange={vi.fn()} /></Providers>);
  expect(screen.getByText("Select at least one request source to continue.")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Matter" })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "Emails" })).toBeVisible();
  expect(screen.queryByRole("checkbox", { name: "Begin Bates" })).not.toBeInTheDocument();
});
