/** Select matter-specific code columns without relying on vendor or request names. */
import { Checkbox, Column, Heading, Row, Text } from "@once-ui-system/core";
import type { Analysis, Job, PleadingSettings, RequestSource } from "@/lib/types";

function requestCandidates(analysis: Analysis) {
  if (analysis.request_candidates?.length) return analysis.request_candidates;
  return analysis.headers
    .filter((column) => ![analysis.begin_bates_header, analysis.end_bates_header].includes(column))
    .map((column) => {
      const colon = column.indexOf(":");
      const combined = column.trim().toLowerCase() === "rfp";
      return { column, category: colon >= 0 ? column.slice(0, colon).trim() : "",
        code: colon >= 0 ? column.slice(colon + 1).trim() : column,
        layout: combined ? "category" as const : "individual" as const,
        input_separator: combined ? "legacy" as const : "auto" as const,
        suggested: /\b(?:rfps?|rogs?)\b/i.test(column), samples: [] as string[] };
    });
}

export function initialPleadingSettings(job: Job): PleadingSettings {
  const settings = job.pleading_settings ?? { delimiter: "comma", include_and: true };
  if (settings.request_sources != null || !job.analysis?.request_candidates) return settings;
  return { ...settings, request_sources: requestCandidates(job.analysis).filter((item) => item.suggested)
    .map(({ column, layout, input_separator }) => ({ column, layout, input_separator })) };
}

const SEPARATORS = [
  ["auto", "Detect category prefixes"], ["single", "Single code"], ["semicolon", "Semicolon"],
  ["comma", "Comma"], ["pipe", "Pipe"], ["newline", "New line"], ["legacy", "Existing RFP list format"],
] as const;

export function RequestSourcesEditor({ analysis, settings, onChange }: {
  analysis: Analysis; settings: PleadingSettings; onChange: (settings: PleadingSettings) => void;
}) {
  const candidates = requestCandidates(analysis);
  const selected = settings.request_sources ?? candidates.filter((c) => c.suggested)
    .map(({ column, layout, input_separator }) => ({ column, layout, input_separator }));
  const update = (source: RequestSource) => onChange({ ...settings,
    request_sources: selected.map((item) => item.column === source.column ? source : item) });
  const groups = [...new Set(candidates.map((c) => c.category || "Other columns"))];
  return <Column fillWidth background="surface" border="neutral-alpha-weak" radius="l" padding="24" gap="20">
    <Column gap="4">
      <Heading as="h2" variant="heading-strong-m">Request sources</Heading>
      <Text variant="body-default-s" onBackground="neutral-weak">
        Choose the codes to include in this pleading. Suggestions can be changed for any matter.
      </Text>
    </Column>
    {groups.map((group) => <Column key={group} gap="12">
      <Heading as="h3" variant="heading-strong-s">{group}</Heading>
      {candidates.filter((c) => (c.category || "Other columns") === group).map((candidate) => {
        const source = selected.find((s) => s.column === candidate.column);
        return <Column key={candidate.column} gap="8" className="request-source-row">
          <Checkbox label={candidate.code || candidate.column} isChecked={Boolean(source)} onToggle={() => onChange({
            ...settings, request_sources: source ? selected.filter((s) => s.column !== candidate.column)
              : [...selected, { column: candidate.column, layout: candidate.layout, input_separator: candidate.input_separator }],
          })} />
          {source && <Row gap="12" wrap>
            <label className="request-source-control">Source layout
              <select aria-label={`Source layout for ${candidate.column}`} value={source.layout}
                onChange={(event) => update({ ...source, layout: event.target.value as RequestSource["layout"] })}>
                <option value="individual">Individual code column</option>
                <option value="category">Category/code list</option>
              </select>
            </label>
            {source.layout === "category" && <label className="request-source-control">Input code separator
              <select aria-label={`Input code separator for ${candidate.column}`} value={source.input_separator ?? "auto"}
                onChange={(event) => update({ ...source,
                  input_separator: event.target.value as RequestSource["input_separator"] })}>
                {SEPARATORS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>}
          </Row>}
          {Boolean(candidate.samples?.length) && <Text variant="body-default-xs" onBackground="neutral-weak">
            Source examples: {candidate.samples?.join(" · ")}
          </Text>}
          {source && <Text variant="body-default-xs" onBackground="neutral-weak">
            {source.layout === "individual" ? `Pleading heading: ${candidate.code || candidate.column}`
              : "Each applied code becomes a separate heading. Check the parsed headings in Review."}
          </Text>}
        </Column>;
      })}
    </Column>)}
    {!selected.length && <Text variant="body-default-s">Select at least one request source to continue.</Text>}
  </Column>;
}
