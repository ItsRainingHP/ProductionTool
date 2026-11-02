/** Tests for browser-local mapping template import, export, and application. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTemplate, createTemplate, exportTemplates, importTemplates, loadTemplates, saveTemplates, updateTemplate } from "./templates";
import type { OutputColumn } from "./types";

const columns: OutputColumn[] = [{
  id: "author",
  name: "Author",
  source_fields: ["Author"],
  transform: { kind: "none", delimiter: null },
  normalize: true, replace_true_with_header: false,
}];

describe("mapping templates", () => {
  it.each(["null", "true", "42", '"template"', "[]"])("rejects non-object template files: %s", (text) => {
    expect(() => importTemplates(text)).toThrow("The template file does not use the supported schema.");
  });
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "11111111-1111-4111-8111-111111111111") });
  });

  it("stores, renames, and updates a template without sharing column arrays", () => {
    const template = createTemplate("Review", columns);
    const updated = updateTemplate(template, "Renamed", [{ ...columns[0], name: "Creator" }]);
    saveTemplates([updated]);
    const loaded = loadTemplates();
    expect(loaded[0].name).toBe("Renamed");
    expect(loaded[0].columns[0].name).toBe("Creator");
  });

  it("reports source headers that are missing when applying", () => {
    const result = applyTemplate(createTemplate("Review", columns), ["Custodian"]);
    expect(result.missing).toEqual(["Author"]);
    expect(result.columns[0].source_fields).toEqual([]);
  });

  it("rejects malformed imported transforms", () => {
    const malformed = JSON.stringify({
      schemaVersion: 1,
      templates: [{ ...createTemplate("Review", columns), columns: [{ ...columns[0], transform: { kind: "execute" } }] }],
    });
    expect(() => importTemplates(malformed)).toThrow(/supported schema/i);
  });

  it("round-trips Join templates through export and import", () => {
    const joined: OutputColumn = {
      ...columns[0],
      source_fields: ["Author", "From"],
      transform: { kind: "delimit", delimiter: "; " },
    };

    const [imported] = importTemplates(exportTemplates([createTemplate("Joined", [joined])]));

    expect(imported.name).toBe("Joined");
    expect(imported.columns[0].transform).toEqual({ kind: "delimit", delimiter: "; " });
  });

  it("normalizes legacy concatenate templates to Join on import and load", () => {
    const legacy = createTemplate("Legacy", columns);
    const payload = JSON.stringify({
      schemaVersion: 1,
      templates: [{
        ...legacy,
        columns: [{
          ...legacy.columns[0],
          source_fields: ["Author", "From"],
          transform: { kind: "concatenate", delimiter: ", " },
        }],
      }],
    });

    expect(importTemplates(payload)[0].columns[0].transform.kind).toBe("delimit");
    window.localStorage.setItem("production-tool.mapping-templates.v1", JSON.stringify(JSON.parse(payload).templates));
    expect(loadTemplates()[0].columns[0].transform.kind).toBe("delimit");
  });

  it("preserves spaces while a template is renamed", () => {
    expect(updateTemplate(createTemplate("Original", columns), "Two Words").name).toBe("Two Words");
  });

  it("preserves mixed column choices in schema 2 and defaults schema 1 to off", () => {
    const mixed = [columns[0], { ...columns[0], id: "raw", name: "Raw", replace_true_with_header: true }];
    const exported = exportTemplates([createTemplate("Mixed", mixed)]);
    expect(JSON.parse(exported).schemaVersion).toBe(2);
    expect(importTemplates(exported)[0].columns.map((column) => column.replace_true_with_header)).toEqual([false, true]);
    const legacy = { ...createTemplate("Old", columns), schemaVersion: 1,
      columns: columns.map((column) => ({ id: column.id, name: column.name, source_fields: column.source_fields,
        transform: column.transform, normalize: column.normalize })) };
    expect(importTemplates(JSON.stringify({ schemaVersion: 1, templates: [legacy] }))[0].columns[0].replace_true_with_header).toBe(false);
    const malformed = JSON.parse(exported);
    delete malformed.templates[0].columns[0].replace_true_with_header;
    expect(() => importTemplates(JSON.stringify(malformed))).toThrow(/supported schema/);
    malformed.templates[0].columns = [{ ...mixed[1], source_fields: ["Begin", "End"], transform: { kind: "shorten_bates" } }];
    expect(() => importTemplates(JSON.stringify(malformed))).toThrow(/supported schema/);
  });

  it.each([
    { name: "X".repeat(121) },
    { columns: [{ ...columns[0], source_fields: ["Author", "Author"] }] },
    { columns: [{ ...columns[0], transform: { kind: "delimit", delimiter: "unsafe" } }] },
    { columns: [{ ...columns[0], transform: { kind: "none" }, source_fields: ["Author", "From"] }] },
    { columns: [columns[0], { ...columns[0], id: "another", name: "author" }] },
  ])("rejects imported templates that the API would reject: %j", (change) => {
    const malformed = { ...createTemplate("Review", columns), ...change };
    expect(() => importTemplates(JSON.stringify({ schemaVersion: 1, templates: [malformed] }))).toThrow(/supported schema/i);
  });

  it("reports unavailable storage without changing the saved list", () => {
    vi.mocked(window.localStorage.setItem).mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    expect(() => saveTemplates([createTemplate("Review", columns)])).toThrow(/storage is unavailable or full/i);
  });

  it("rejects oversized imports and malformed template entries", () => {
    expect(() => importTemplates("x".repeat(256 * 1024 + 1))).toThrow(/256 KiB/);
    expect(() => importTemplates(JSON.stringify({ schemaVersion: 1, templates: [null] }))).toThrow(/supported schema/);
    const template = createTemplate("Review", columns);
    expect(() => importTemplates(JSON.stringify({ schemaVersion: 1, templates: [{ ...template, columns: [null] }] })))
      .toThrow(/supported schema/);
  });

  it("returns no templates for corrupted browser storage or outside a browser", () => {
    vi.mocked(window.localStorage.getItem).mockReturnValueOnce("not-json");
    expect(loadTemplates()).toEqual([]);
    vi.stubGlobal("window", undefined);
    try { expect(loadTemplates()).toEqual([]); }
    finally { vi.unstubAllGlobals(); }
  });
});
