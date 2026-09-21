/** Browser-local, versioned privilege mapping templates. */

import type { MappingTemplate, OutputColumn } from "./types";

const STORAGE_KEY = "production-tool.mapping-templates.v1";
const MAX_IMPORT_BYTES = 256 * 1024;

type ImportedOutputColumn = Omit<OutputColumn, "transform"> & {
  transform: Omit<OutputColumn["transform"], "kind"> & { kind: OutputColumn["transform"]["kind"] | "concatenate" };
};

function normalizeTemplate(value: unknown): MappingTemplate | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<MappingTemplate>;
  const valid = item.schemaVersion === 1
    && typeof item.id === "string"
    && typeof item.name === "string"
    && item.name.trim().length > 0
    && Array.isArray(item.columns)
    && item.columns.length > 0
    && item.columns.length <= 100
    && item.columns.every((column) => {
      if (!column || typeof column !== "object") return false;
      const candidate = column as Partial<ImportedOutputColumn>;
      return typeof candidate.id === "string"
        && typeof candidate.name === "string"
        && candidate.name.trim().length > 0
        && !/[\u0000-\u001f\u007f]/.test(candidate.name)
        && Array.isArray(candidate.source_fields)
        && candidate.source_fields.length > 0
        && candidate.source_fields.every((field) => typeof field === "string" && field.length > 0)
        && typeof candidate.normalize === "boolean"
        && !!candidate.transform
        && ["none", "shorten_bates", "delimit", "fill", "concatenate"].includes(candidate.transform.kind)
        && (candidate.transform.delimiter == null || typeof candidate.transform.delimiter === "string");
    });
  if (!valid) return null;
  return {
    ...(item as MappingTemplate),
    columns: item.columns!.map((column) => {
      const imported = column as ImportedOutputColumn;
      return {
        ...imported,
        source_fields: [...imported.source_fields],
        transform: {
          ...imported.transform,
          kind: imported.transform.kind === "concatenate" ? "delimit" : imported.transform.kind,
        },
      } as OutputColumn;
    }),
  };
}

export function loadTemplates(): MappingTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.map(normalizeTemplate).filter((item): item is MappingTemplate => item !== null) : [];
  } catch {
    return [];
  }
}

export function saveTemplates(templates: MappingTemplate[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

export function createTemplate(name: string, columns: OutputColumn[]): MappingTemplate {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    columns: columns.map((column) => ({ ...column, source_fields: [...column.source_fields], transform: { ...column.transform } })),
  };
}

export function updateTemplate(template: MappingTemplate, name: string, columns?: OutputColumn[]): MappingTemplate {
  return {
    ...template,
    name,
    updatedAt: new Date().toISOString(),
    columns: (columns ?? template.columns).map((column) => ({
      ...column,
      source_fields: [...column.source_fields],
      transform: { ...column.transform },
    })),
  };
}

export function exportTemplates(templates: MappingTemplate[]): string {
  return `${JSON.stringify({ schemaVersion: 1, templates }, null, 2)}\n`;
}

export function importTemplates(text: string): MappingTemplate[] {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error("Template files must be 256 KB or smaller.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("The template file is not valid JSON."); }
  const payload = value as { schemaVersion?: unknown; templates?: unknown };
  const templates = Array.isArray(payload.templates) ? payload.templates.map(normalizeTemplate) : [];
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.templates) || templates.some((template) => template === null)) {
    throw new Error("The template file does not use the supported schema.");
  }
  return templates.map((template) => ({ ...template!, id: crypto.randomUUID(), updatedAt: new Date().toISOString() }));
}

export function applyTemplate(template: MappingTemplate, headers: string[]): { columns: OutputColumn[]; missing: string[] } {
  const available = new Set(headers);
  const missing = [...new Set(template.columns.flatMap((column) => column.source_fields).filter((field) => !available.has(field)))];
  return {
    columns: template.columns.map((column) => ({
      ...column,
      id: crypto.randomUUID(),
      source_fields: column.source_fields.filter((field) => available.has(field)),
      transform: { ...column.transform },
    })),
    missing,
  };
}
