/**
 * @file Privilege-log column mapping, transformation, and ordering editor.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Column, Heading, Input, Row, Tag, Text } from "@once-ui-system/core";
import type { OutputColumn, TransformKind } from "@/lib/types";

const TRANSFORMS: Array<{ kind: TransformKind; label: string; help: string }> = [
  { kind: "none", label: "Direct", help: "Copy the selected source field without changing it." },
  { kind: "shorten_bates", label: "Bates range", help: "Combine exactly two Bates fields into a shortened range." },
  { kind: "delimit", label: "Join", help: "Combine populated source fields using the chosen separator." },
  { kind: "fill", label: "Fill", help: "Use the first populated source field, checking them in the order shown." },
];

const DELIMITERS: Array<{ value: OutputColumn["transform"]["delimiter"]; label: string }> = [
  { value: "; ", label: "Semicolon" },
  { value: ", ", label: "Comma" },
  { value: " | ", label: "Pipe" },
  { value: "\n", label: "New line" },
];

function recommendedTransform(fields: string[]): OutputColumn["transform"] {
  if (fields.length <= 1) return { kind: "none", delimiter: null };
  const names = fields.join(" ").toLocaleLowerCase();
  return names.includes("bates") && fields.length === 2
    ? { kind: "shorten_bates", delimiter: null }
    : { kind: "delimit", delimiter: "; " };
}

function validTransform(transform: OutputColumn["transform"], fieldCount: number): boolean {
  if (!fieldCount) return false;
  if (transform.kind === "none") return fieldCount === 1;
  if (transform.kind === "shorten_bates") return fieldCount === 2;
  return true;
}

function SourceField({ field, selected, usedCount, onSelect, onBeginDrag }: { field: string; selected: boolean; usedCount: number; onSelect: () => void; onBeginDrag: () => void }) {
  return (
    <Button
      type="button"
      variant={selected ? "primary" : "secondary"}
      size="s"
      fillWidth
      horizontal="start"
      className={`source-chip ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      onMouseDown={onBeginDrag}
      onTouchStart={onBeginDrag}
      aria-pressed={selected}
    >
      <span className="source-grip" aria-hidden>⋮⋮</span>
      <span>{field}</span>
      <span className="source-add" aria-label={usedCount ? `Used in ${usedCount} output columns` : "Unused"}>{usedCount ? `${usedCount}×` : "+"}</span>
    </Button>
  );
}

function ColumnDropZone({ active, draggedField, onDropField, children }: { active: boolean; draggedField: string | null; onDropField: (field: string) => void; children: React.ReactNode }) {
  const [isOver, setIsOver] = useState(false);
  return (
    <div
      className={`mapping-fields ${active || isOver ? "is-active" : ""}`}
      onMouseEnter={() => draggedField && setIsOver(true)}
      onMouseLeave={() => setIsOver(false)}
      onMouseUp={() => {
        setIsOver(false);
        if (draggedField) onDropField(draggedField);
      }}
    >
      {children}
    </div>
  );
}

export function MappingEditor({ headers, columns, onChange }: { headers: string[]; columns: OutputColumn[]; onChange: (columns: OutputColumn[]) => void }) {
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [draggedField, setDraggedField] = useState<string | null>(null);
  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    columns.flatMap((column) => column.source_fields).forEach((field) => counts.set(field, (counts.get(field) ?? 0) + 1));
    return counts;
  }, [columns]);
  const available = headers;
  const filteredAvailable = available.filter((header) => header.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const incompleteColumns = columns.filter((column) => !column.name.trim() || !column.source_fields.length || !validTransform(column.transform, column.source_fields.length));

  useEffect(() => {
    const finishDrag = () => setDraggedField(null);
    window.addEventListener("mouseup", finishDrag);
    window.addEventListener("touchend", finishDrag);
    return () => {
      window.removeEventListener("mouseup", finishDrag);
      window.removeEventListener("touchend", finishDrag);
    };
  }, []);

  const updateColumn = (id: string, update: Partial<OutputColumn>) => {
    onChange(columns.map((column) => column.id === id ? { ...column, ...update } : column));
  };

  const setFields = (columnId: string, fields: string[]) => {
    onChange(columns.map((column) => {
      if (column.id !== columnId) return column;
      const transform = validTransform(column.transform, fields.length) ? column.transform : recommendedTransform(fields);
      return { ...column, source_fields: fields, transform };
    }));
  };

  const assignField = (columnId: string, field: string) => {
    const target = columns.find((column) => column.id === columnId);
    if (!target || target.source_fields.includes(field)) return;
    setFields(columnId, [...target.source_fields, field]);
    setSelectedField(null);
  };

  const removeField = (columnId: string, field: string) => {
    const target = columns.find((column) => column.id === columnId);
    if (!target) return;
    setFields(columnId, target.source_fields.filter((item) => item !== field));
  };

  const moveField = (columnId: string, index: number, direction: -1 | 1) => {
    const target = columns.find((column) => column.id === columnId);
    if (!target) return;
    const destination = index + direction;
    if (destination < 0 || destination >= target.source_fields.length) return;
    const fields = [...target.source_fields];
    [fields[index], fields[destination]] = [fields[destination], fields[index]];
    setFields(columnId, fields);
  };

  const addColumn = () => {
    onChange([
      ...columns,
      {
        id: crypto.randomUUID(),
        name: `Output column ${columns.length + 1}`,
        source_fields: [],
        transform: { kind: "none", delimiter: null },
        normalize: false,
      },
    ]);
  };

  const moveColumn = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= columns.length) return;
    const next = [...columns];
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  };

  const chooseTransform = (column: OutputColumn, kind: TransformKind) => {
    const delimiter = kind === "delimit" ? (column.transform.delimiter ?? "; ") : null;
    updateColumn(column.id, { transform: { kind, delimiter } });
  };

  return (
    <Row fillWidth gap="24" vertical="start" m={{ direction: "column" }}>
        <Column width={24} m={{ width: "100%" }} gap="16" background="surface" border="neutral-alpha-weak" radius="l" padding="20" className="source-palette">
          <Column gap="4">
            <Heading as="h3" variant="heading-strong-s">Source fields</Heading>
            <Text variant="body-default-xs" onBackground="neutral-weak">Select a field and choose an output column, or drag it directly into one.</Text>
          </Column>
          <Input id="source-field-search" label="Search available fields" value={search} onChange={(event) => setSearch(event.target.value)} />
          {selectedField && (
            <Row fillWidth horizontal="between" vertical="center" gap="8" padding="12" radius="m" background="brand-alpha-weak">
              <Column gap="2" minWidth={0}>
                <Text variant="label-default-xs" onBackground="brand-medium">SELECTED</Text>
                <Text variant="label-strong-s">{selectedField}</Text>
              </Column>
              <Button size="s" variant="tertiary" onClick={() => setSelectedField(null)}>Clear</Button>
            </Row>
          )}
          <div className="source-list">
            {filteredAvailable.map((field) => (
              <SourceField
                key={field}
                field={field}
                selected={selectedField === field}
                usedCount={usage.get(field) ?? 0}
                onSelect={() => setSelectedField((current) => current === field ? null : field)}
                onBeginDrag={() => setDraggedField(field)}
              />
            ))}
            {!filteredAvailable.length && (
              <Text variant="body-default-s" onBackground="neutral-weak">
                {available.length ? "No source fields match that search." : "No source fields were detected."}
              </Text>
            )}
          </div>
          <Button variant="secondary" size="s" onClick={addColumn}>Add empty output column</Button>
          <Text variant="body-default-xs" onBackground="neutral-weak">Source fields can be reused in more than one output column.</Text>
        </Column>

        <Column flex={1} gap="16" fillWidth>
          <Row fillWidth horizontal="between" vertical="center" gap="12" wrap>
            <Column gap="2">
              <Heading as="h3" variant="heading-strong-s">Output columns</Heading>
              <Text variant="body-default-xs" onBackground="neutral-weak">Source order controls Fill and Join results.</Text>
            </Column>
            <Tag variant={incompleteColumns.length ? "warning" : "success"}>
              {incompleteColumns.length ? `${incompleteColumns.length} column${incompleteColumns.length === 1 ? "" : "s"} need attention` : "Mapping ready"}
            </Tag>
          </Row>

          {columns.map((column, index) => {
            const transform = TRANSFORMS.find((item) => item.kind === column.transform.kind) ?? TRANSFORMS[0];
            return (
              <Column key={column.id} background="surface" border="neutral-alpha-weak" radius="l" padding="20" gap="16" className="mapping-column-card">
                <Row fillWidth gap="12" vertical="center" s={{ direction: "column", vertical: "stretch" }}>
                  <Input
                    id={`column-${column.id}`}
                    label={`Output column ${index + 1}`}
                    value={column.name}
                    onChange={(event) => updateColumn(column.id, { name: event.target.value })}
                    style={{ flex: 1 }}
                  />
                  <Row gap="4">
                    <Button aria-label="Move column left" title="Move column left" className="icon-action" variant="tertiary" size="s" onClick={() => moveColumn(index, -1)} disabled={index === 0}>←</Button>
                    <Button aria-label="Move column right" title="Move column right" className="icon-action" variant="tertiary" size="s" onClick={() => moveColumn(index, 1)} disabled={index === columns.length - 1}>→</Button>
                    <Button aria-label={`Remove ${column.name}`} variant="danger" size="s" onClick={() => onChange(columns.filter((item) => item.id !== column.id))}>Remove</Button>
                  </Row>
                </Row>

                <ColumnDropZone active={Boolean(selectedField || draggedField)} draggedField={draggedField} onDropField={(field) => assignField(column.id, field)}>
                  <Column gap="12">
                    <Row fillWidth horizontal="between" vertical="center" gap="12" wrap>
                      <Text variant="label-strong-s">Source priority</Text>
                      <Button
                        size="s"
                        variant={selectedField ? "primary" : "tertiary"}
                        disabled={!selectedField}
                        onClick={() => selectedField && assignField(column.id, selectedField)}
                      >
                        {selectedField ? `Add ${selectedField} here` : "Select a source field first"}
                      </Button>
                    </Row>
                    {column.source_fields.length ? (
                      <div className="mapping-field-list">
                        {column.source_fields.map((field, fieldIndex) => (
                          <div key={field} className="mapping-field-row">
                            <span className="field-order">{fieldIndex + 1}</span>
                            <Text variant="label-default-s">{field}</Text>
                            <Row gap="4" className="field-actions">
                              <Button aria-label={`Move ${field} earlier`} title="Move earlier" className="icon-action" variant="tertiary" size="s" onClick={() => moveField(column.id, fieldIndex, -1)} disabled={fieldIndex === 0}>↑</Button>
                              <Button aria-label={`Move ${field} later`} title="Move later" className="icon-action" variant="tertiary" size="s" onClick={() => moveField(column.id, fieldIndex, 1)} disabled={fieldIndex === column.source_fields.length - 1}>↓</Button>
                              <Button aria-label={`Remove ${field} from ${column.name}`} title="Remove field" className="icon-action" variant="tertiary" size="s" onClick={() => removeField(column.id, field)}>×</Button>
                            </Row>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Text variant="body-default-s" onBackground="neutral-weak">Drop a source field here or select one from the left and use “Add here.”</Text>
                    )}
                  </Column>
                </ColumnDropZone>

                <Column gap="12">
                  <Column gap="2">
                    <Text variant="label-strong-s">How should this column be built?</Text>
                    <Text variant="body-default-xs" onBackground="neutral-weak">{transform.help}</Text>
                  </Column>
                  <div className="transform-grid" role="group" aria-label={`Transform for ${column.name}`}>
                    {TRANSFORMS.map((option) => {
                      const disabled = !column.source_fields.length
                        || (option.kind === "none" && column.source_fields.length !== 1)
                        || (option.kind === "shorten_bates" && column.source_fields.length !== 2)
                        || (option.kind === "delimit" && column.source_fields.length < 2);
                      return (
                        <Button
                          key={option.kind}
                          type="button"
                          size="s"
                          variant={column.transform.kind === option.kind ? "primary" : "secondary"}
                          className={`transform-choice ${column.transform.kind === option.kind ? "is-active" : ""}`}
                          aria-pressed={column.transform.kind === option.kind}
                          disabled={disabled}
                          onClick={() => chooseTransform(column, option.kind)}
                        >
                          {option.label}
                        </Button>
                      );
                    })}
                  </div>
                  {column.transform.kind === "delimit" && (
                    <Row gap="8" wrap>
                      <Text variant="label-default-s">Separator:</Text>
                      {DELIMITERS.map((delimiter) => (
                        <Button
                          key={delimiter.label}
                          size="s"
                          variant={column.transform.delimiter === delimiter.value ? "primary" : "secondary"}
                          onClick={() => updateColumn(column.id, { transform: { ...column.transform, delimiter: delimiter.value } })}
                        >
                          {delimiter.label}
                        </Button>
                      ))}
                    </Row>
                  )}
                  <Column gap="4" padding="12" radius="m" background="neutral-alpha-weak">
                    <Checkbox
                      label="Normalize names and emails"
                      isChecked={column.normalize}
                      onToggle={() => updateColumn(column.id, { normalize: !column.normalize })}
                    />
                    <Text variant="body-default-xs" onBackground="neutral-weak">
                      Capitalizes name text and removes quotes or angle brackets surrounding email addresses. The source CSV is not changed.
                    </Text>
                  </Column>
                </Column>
              </Column>
            );
          })}

          <Button variant="secondary" onClick={addColumn}>Add another empty output column</Button>
        </Column>
    </Row>
  );
}
