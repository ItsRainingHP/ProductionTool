"use client";

import { useRef, useState } from "react";
import { Button, Column, Heading, Input, Row, Text } from "@once-ui-system/core";
import type { MappingTemplate, OutputColumn } from "@/lib/types";
import { applyTemplate, createTemplate, exportTemplates, importTemplates, saveTemplates, updateTemplate } from "@/lib/templates";

export function TemplateManager({ headers, columns, templates, onTemplatesChange, onApply, onError }: {
  headers: string[];
  columns: OutputColumn[];
  templates: MappingTemplate[];
  onTemplatesChange: (templates: MappingTemplate[]) => void;
  onApply: (columns: OutputColumn[], missing: string[]) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const commit = (next: MappingTemplate[]) => { saveTemplates(next); onTemplatesChange(next); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportTemplates(templates)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "production-tool-mapping-templates.json"; link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Column gap="12" padding="16" radius="m" background="neutral-alpha-weak" className="template-manager">
      <Heading as="h3" variant="heading-strong-s">Mapping templates</Heading>
      <Text variant="body-default-xs" onBackground="neutral-weak">Templates stay in this browser and contain field mappings only.</Text>
      <input ref={fileInput} className="visually-hidden" type="file" accept="application/json,.json" aria-label="Import mapping templates" onChange={async (event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return;
        try { commit([...templates, ...importTemplates(await file.text())]); } catch (reason) { onError(reason instanceof Error ? reason.message : "Unable to import templates."); }
      }} />
      <Row gap="8" vertical="end" wrap>
        <Input id="template-name" label="Template name" value={name} onChange={(event) => setName(event.target.value)} />
        <Button size="s" disabled={!name.trim() || !columns.length} onClick={() => { commit([...templates, createTemplate(name, columns)]); setName(""); }}>Save current mapping</Button>
        <Button size="s" variant="secondary" onClick={() => fileInput.current?.click()}>Import JSON</Button>
        <Button size="s" variant="secondary" disabled={!templates.length} onClick={download}>Export JSON</Button>
      </Row>
      {templates.map((template) => <Row key={template.id} fillWidth horizontal="between" vertical="center" gap="8" wrap>
        <Input
          id={`template-${template.id}`}
          label="Template name"
          value={template.name}
          onChange={(event) => commit(templates.map((item) => item.id === template.id ? updateTemplate(item, event.target.value) : item))}
          onBlur={(event) => commit(templates.map((item) => item.id === template.id ? updateTemplate(item, event.target.value.trim()) : item))}
        />
        <Row gap="4">
          <Button size="s" variant="secondary" onClick={() => { const result = applyTemplate(template, headers); onApply(result.columns, result.missing); }}>Apply</Button>
          <Button size="s" variant="secondary" disabled={!columns.length || !template.name.trim()} onClick={() => commit(templates.map((item) => item.id === template.id ? updateTemplate(item, item.name, columns) : item))}>Update mapping</Button>
          <Button size="s" variant="danger" onClick={() => commit(templates.filter((item) => item.id !== template.id))}>Delete</Button>
        </Row>
      </Row>)}
    </Column>
  );
}
