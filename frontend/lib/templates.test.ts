/** Tests for browser-local mapping template import, export, and application. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTemplate, createTemplate, exportTemplates, importTemplates, loadTemplates, saveTemplates, updateTemplate } from "./templates";
import type { OutputColumn } from "./types";

const columns: OutputColumn[] = [{
  id: "author",
  name: "Author",
  source_fields: ["Author"],
  transform: { kind: "none", delimiter: null },
  normalize: true,
}];

describe("mapping templates", () => {
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
});
