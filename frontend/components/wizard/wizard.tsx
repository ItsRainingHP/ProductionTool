/**
 * @file Stateful five-step workflow for upload, configuration, review, and download.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, Card, Column, Grid, Heading, Icon, Input, ProgressBar, Row, Table, Tag, Text } from "@once-ui-system/core";
import { AppFooter } from "@/components/app-footer";
import { AppHeader } from "@/components/app-header";
import { createJob, deleteJob, finalizeJob, getCapabilities, getJob, getPreview, readyForReview, setMapping, setPleadingSettings, setWorkflow, uploadSource } from "@/lib/api";
import { defaultOutputFilename, formatBytes, platformConfidenceLabel, platformConfidenceSentence } from "@/lib/format";
import type { Capabilities, Job, MappingTemplate, OutputColumn, PleadingSettings, Preview, Workflow } from "@/lib/types";
import { blockingIssues, clientFileError, validationTone, warningIssues, warningsAcknowledged } from "@/lib/validation";
import { MappingEditor } from "./mapping-editor";
import { TemplateManager } from "./template-manager";
import { PersonalDataNotice } from "./personal-data-notice";
import { DEFAULT_PLEADING_SETTINGS, PleadingSettingsEditor } from "./pleading-settings-editor";
import { StepKey, Stepper, steps } from "./stepper";
import { ValidationResults } from "./validation-results";
import { WorkflowSelector } from "./workflow-selector";
import { UploadProgress } from "./upload-progress";

const DEFAULT_CAPABILITIES: Capabilities = {
  max_upload_bytes: 500 * 1024 * 1024,
  job_ttl_seconds: 4 * 60 * 60,
  max_active_jobs: 20,
  max_total_job_bytes: 5 * 1024 * 1024 * 1024,
  supported_content_types: ["", "application/csv", "application/octet-stream", "application/vnd.ms-excel", "text/csv", "text/plain"],
  features: [],
};

const activeJobStatuses = new Set<Job["status"]>(["uploading", "analyzing", "preparing_review", "processing"]);
const terminalAnalysisStatuses = new Set<Job["status"]>(["needs_configuration", "failed"]);

async function pollJob(jobId: string, onUpdate: (job: Job) => void, terminal: (job: Job) => boolean): Promise<Job> {
  let delay = 500;
  for (;;) {
    const current = await getJob(jobId);
    onUpdate(current);
    if (terminal(current)) return current;
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    delay = Math.min(5000, Math.round(delay * 1.5));
  }
}

function maximumStep(job: Job): StepKey {
  if (["awaiting_upload", "uploading", "analyzing"].includes(job.status)) return "upload";
  if (job.status === "failed") return job.analysis ? "data" : "upload";
  if (job.status === "preparing_review") return "review";
  if (job.status === "needs_configuration") return "advanced";
  if (job.status === "ready_for_review" || job.status === "processing") return "review";
  return "download";
}

function defaultMapping(job: Job): OutputColumn[] {
  const analysis = job.analysis;
  if (!analysis) return [];
  const columns: OutputColumn[] = [];
  const assigned = new Set<string>();
  if (analysis.begin_bates_header && analysis.end_bates_header) {
    columns.push({
      id: crypto.randomUUID(),
      name: "Bates Range",
      source_fields: [analysis.begin_bates_header, analysis.end_bates_header],
      transform: { kind: "shorten_bates", delimiter: null },
      normalize: false,
    });
    assigned.add(analysis.begin_bates_header);
    assigned.add(analysis.end_bates_header);
  }
  analysis.headers.filter((header) => !assigned.has(header)).slice(0, 5).forEach((header) => {
    columns.push({ id: crypto.randomUUID(), name: header, source_fields: [header], transform: { kind: "none", delimiter: null }, normalize: false });
  });
  return columns;
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <Column fillWidth background="surface" border="neutral-alpha-weak" radius="l" padding="24" gap="20" className={className}>{children}</Column>;
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <Row role="alert" fillWidth gap="12" padding="16" radius="m" background="danger-alpha-weak" border="danger-alpha-medium" vertical="center">
      <Icon name="warning" onBackground="danger-medium" />
      <Text variant="body-default-s">{message}</Text>
    </Row>
  );
}

export function Wizard() {
  const router = useRouter();
  const params = useParams<{ segments?: string[] }>();
  const segments = params.segments ?? [];
  const routeJobId = segments[0];
  const routeStep = steps.some((item) => item.key === segments[1]) ? segments[1] as StepKey : "upload";
  const [step, setStep] = useState<StepKey>(routeStep);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(Boolean(routeJobId));
  const [error, setError] = useState("");
  const [uploadTransfer, setUploadTransfer] = useState({ loaded: 0, total: 0, percent: 0 });
  const [uploadFile, setUploadFile] = useState<{ name: string; size: number } | null>(null);
  const [uploadSessionActive, setUploadSessionActive] = useState(false);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [mappingColumns, setMappingColumns] = useState<OutputColumn[]>([]);
  const [pleadingSettings, setPleadingSettingsState] = useState<PleadingSettings>({ ...DEFAULT_PLEADING_SETTINGS });
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outputFilename, setOutputFilename] = useState("");
  const [capabilities, setCapabilities] = useState<Capabilities>(DEFAULT_CAPABILITIES);
  const [templates, setTemplates] = useState<MappingTemplate[]>([]);
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const localUploadJobId = useRef<string | null>(null);
  const cancelRequested = useRef(false);
  const uploadAbortController = useRef<AbortController | null>(null);

  useEffect(() => {
    getCapabilities().then(setCapabilities).catch(() => undefined);
    import("@/lib/templates").then(({ loadTemplates }) => setTemplates(loadTemplates()));
  }, []);

  useEffect(() => {
    if (routeStep !== "data" || routeJobId !== localUploadJobId.current) return;
    localUploadJobId.current = null;
    setUploadSessionActive(false);
  }, [routeJobId, routeStep]);

  const effectiveMappingColumns = useMemo(() => {
    if (mappingColumns.length) return mappingColumns;
    if (job?.workflow === "privilege_log") return defaultMapping(job);
    return [];
  }, [mappingColumns, job]);

  const navigate = useCallback((next: StepKey, jobId = job?.job_id) => {
    setStep(next);
    router.push(jobId ? `/wizard/${jobId}/${next}` : "/wizard");
    window.setTimeout(() => document.querySelector<HTMLElement>("#step-title")?.focus(), 20);
  }, [job?.job_id, router]);

  const requestNavigation = useCallback((next: StepKey) => {
    if (busy) return;
    if (step === "advanced" && advancedDirty && !window.confirm("Discard unsaved Advanced-step changes?")) return;
    setAdvancedDirty(false);
    navigate(next);
  }, [advancedDirty, busy, navigate, step]);

  useEffect(() => {
    if (step !== "advanced" || !advancedDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [advancedDirty, step]);

  useEffect(() => {
    if (!routeJobId) return;
    if (routeStep === "upload" && routeJobId === localUploadJobId.current) return;
    let active = true;
    const loadJob = async () => {
      try {
        const loaded = await getJob(routeJobId);
        if (!active) return;
        setJob(loaded);
        setSelectedWorkflow(loaded.workflow ?? (loaded.analysis?.detected_workflow === "unknown" ? null : loaded.analysis?.detected_workflow ?? null));
        if (loaded.mapping) setMappingColumns(loaded.mapping.columns);
        setPleadingSettingsState(loaded.pleading_settings ?? { ...DEFAULT_PLEADING_SETTINGS });
        setAdvancedDirty(false);
        if (routeStep === "review" && loaded.analysis) {
          setOutputFilename(defaultOutputFilename(loaded.analysis.filename, loaded.workflow));
        }
        const maximum = maximumStep(loaded);
        const maximumIndex = steps.findIndex((item) => item.key === maximum);
        const requestedIndex = steps.findIndex((item) => item.key === routeStep);
        const safeStep = requestedIndex > maximumIndex ? maximum : routeStep;
        setStep(safeStep);
        if (safeStep !== routeStep) router.replace(`/wizard/${loaded.job_id}/${safeStep}`);
        if (activeJobStatuses.has(loaded.status)) {
          setBusy(true);
          const resumedAnalysis = loaded.status === "uploading" || loaded.status === "analyzing";
          const current = await pollJob(loaded.job_id, (update) => active && setJob(update), (update) => !activeJobStatuses.has(update.status));
          if (!active) return;
          const destination = resumedAnalysis && current.analysis ? "data" : maximumStep(current);
          setStep(destination);
          router.replace(`/wizard/${current.job_id}/${destination}`);
        }
      } catch (reason) {
        if (!active) return;
        const message = reason instanceof Error ? reason.message : "Unable to load this production job.";
        setError(message === "Job expired" ? "This production job has expired. Start a new upload." : message);
        router.replace("/wizard");
      } finally {
        if (active) setBusy(false);
      }
    };
    void loadJob();
    return () => { active = false; };
  }, [routeJobId, routeStep, router]);

  useEffect(() => {
    if (step !== "review" || !job || job.status === "processing") return;
    getPreview(job.job_id)
      .then(setPreview)
      .catch((reason) => setError(reason.message));
  }, [step, job]);

  const chooseFile = async (file: File) => {
    setError("");
    const fileError = clientFileError(file, capabilities.max_upload_bytes, new Set(capabilities.supported_content_types));
    if (fileError) { setError(fileError); return; }
    const previousJobId = job?.job_id;
    setStep("upload");
    setJob(null);
    setActiveJobId(null);
    setUploadFile({ name: file.name, size: file.size });
    setUploadTransfer({ loaded: 0, total: file.size, percent: 0 });
    setUploadSessionActive(true);
    setBusy(true);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    try {
      if (previousJobId) await deleteJob(previousJobId).catch(() => undefined);
      const created = await createJob();
      setActiveJobId(created.job_id);
      localUploadJobId.current = created.job_id;
      // Keep the active upload in this mounted view. Navigating to an interim
      // upload URL can race the final Data navigation for fast analyses and
      // briefly remount the empty upload form between the two screens.
      uploadAbortController.current = new AbortController();
      const uploaded = await uploadSource(created.job_id, file, setUploadTransfer, uploadAbortController.current.signal);
      setUploadTransfer((current) => ({ ...current, percent: 100 }));
      setJob(uploaded);
      const analyzed = await pollJob(created.job_id, (current) => {
        setJob(current);
      }, (current) => terminalAnalysisStatuses.has(current.status));
      setSelectedWorkflow(analyzed.workflow ?? (analyzed.analysis?.detected_workflow === "unknown" ? null : analyzed.analysis?.detected_workflow ?? null));
      setMappingColumns([]);
      setPleadingSettingsState(analyzed.pleading_settings ?? { ...DEFAULT_PLEADING_SETTINGS });
      setAcknowledged([]);
      setPreview(null);
      setAdvancedDirty(false);
      setActiveJobId(null);
      setStep("data");
      router.replace(`/wizard/${created.job_id}/data`);
      window.setTimeout(() => document.querySelector<HTMLElement>("#step-title")?.focus(), 20);
    } catch (reason) {
      localUploadJobId.current = null;
      setUploadSessionActive(false);
      if (!cancelRequested.current) setError(reason instanceof Error ? reason.message : "The upload failed.");
    } finally {
      cancelRequested.current = false;
      uploadAbortController.current = null;
      setBusy(false);
    }
  };

  const confirmWorkflow = async () => {
    if (!job || !selectedWorkflow || blockingIssues(job.analysis).length) return;
    setBusy(true); setError("");
    try {
      const updated = await setWorkflow(job.job_id, selectedWorkflow);
      setJob(updated);
      if (selectedWorkflow === "privilege_log") setMappingColumns(updated.mapping?.columns ?? defaultMapping(updated));
      if (selectedWorkflow === "rfp_ranges") setPleadingSettingsState(updated.pleading_settings ?? { ...DEFAULT_PLEADING_SETTINGS });
      setAdvancedDirty(false);
      navigate("advanced");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save the workflow."); }
    finally { setBusy(false); }
  };

  const advanceFromAdvanced = async () => {
    if (!job || blockingIssues(job.analysis).length || !warningsAcknowledged(job.analysis, acknowledged)) return;
    setBusy(true); setError("");
    try {
      let updated = job;
      if (job.workflow === "privilege_log") updated = await setMapping(job.job_id, { columns: effectiveMappingColumns });
      if (job.workflow === "rfp_ranges") updated = await setPleadingSettings(job.job_id, pleadingSettings);
      updated = await readyForReview(job.job_id, acknowledged);
      setJob(updated);
      updated = await pollJob(job.job_id, setJob, (current) => current.status === "ready_for_review" || current.status === "failed");
      if (updated.status === "failed") throw new Error(updated.error ?? "Unable to prepare the exact review artifact.");
      setAdvancedDirty(false);
      setOutputFilename(defaultOutputFilename(updated.analysis?.filename ?? "production.csv", updated.workflow));
      navigate("review");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The configuration is incomplete."); }
    finally { setBusy(false); }
  };

  const finalize = async () => {
    if (!job) return;
    setBusy(true); setError("");
    try {
      if (!job.review_token) throw new Error("Prepare the current output for review before finalizing.");
      const updated = await finalizeJob(job.job_id, outputFilename, acknowledged, job.review_token);
      setJob(updated);
      const completed = await pollJob(job.job_id, setJob, (current) => current.status === "complete" || current.status === "failed");
      if (completed.status === "failed") throw new Error(completed.error ?? "Unable to finalize the output.");
      navigate("download");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to finalize the output."); }
    finally { setBusy(false); }
  };

  const resetWorkspace = () => {
    setStep("upload");
    setJob(null);
    setSelectedWorkflow(null);
    setMappingColumns([]);
    setPleadingSettingsState({ ...DEFAULT_PLEADING_SETTINGS });
    setAcknowledged([]);
    setPreview(null);
    setOutputFilename("");
    setUploadTransfer({ loaded: 0, total: 0, percent: 0 });
    setUploadFile(null);
    setUploadSessionActive(false);
    setAdvancedDirty(false);
    setActiveJobId(null);
  };

  const cancelCurrentOperation = async () => {
    const jobId = job?.job_id ?? activeJobId;
    if (!jobId || !window.confirm("Cancel this operation and remove its temporary workspace?")) return;
    setError("");
    cancelRequested.current = true;
    uploadAbortController.current?.abort();
    try {
      await deleteJob(jobId);
      resetWorkspace();
      router.replace("/wizard");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to cancel this operation.");
    } finally {
      setBusy(false);
    }
  };

  const startAgain = async (goHome: boolean) => {
    if (job) await deleteJob(job.job_id).catch(() => undefined);
    resetWorkspace();
    router.push(goHome ? "/" : "/wizard");
  };

  const validationState = validationTone(job?.analysis);
  const hasWarnings = warningIssues(job?.analysis).length > 0;
  const isBlocked = validationState === "blocked";
  const canAdvanceIssues = warningsAcknowledged(job?.analysis, acknowledged);
  const isTextOutput = job?.workflow === "rfp_ranges";
  const mappingIsReady = effectiveMappingColumns.length > 0 && effectiveMappingColumns.every((column) => {
    if (!column.name.trim() || !column.source_fields.length) return false;
    if (column.transform.kind === "none") return column.source_fields.length === 1;
    if (column.transform.kind === "shorten_bates") return column.source_fields.length === 2;
    return column.transform.kind !== "delimit" || Boolean(column.transform.delimiter);
  });
  const operationProgress = job && activeJobStatuses.has(job.status) ? job.progress.percent : uploadTransfer.percent;
  const operationPhase = job?.progress.phase || (uploadTransfer.percent < 100 ? "Uploading CSV" : "Preparing analysis");
  return (
    <Column minHeight="100vh" fillWidth>
      <AppHeader />
      <Column as="main" fillWidth horizontal="center" paddingX="24" paddingY="32">
        <Column fillWidth maxWidth="l" gap="32" className="wizard-shell">
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept=".csv,text/csv,application/csv,application/vnd.ms-excel,text/plain"
            aria-label="Upload source CSV"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void chooseFile(file);
            }}
          />
          <Stepper active={step} onNavigate={requestNavigation} />
          {error && <ErrorNotice message={error} />}
          <div key={step} className="wizard-screen">
            {uploadSessionActive && step === "upload" && (
              <UploadProgress
                file={uploadFile}
                stage={!activeJobId ? "preparing" : job?.status === "analyzing" ? "analyzing" : "uploading"}
                percent={operationProgress}
                transferredBytes={uploadTransfer.loaded}
                transferBytes={uploadTransfer.total}
                phase={operationPhase}
                onCancel={activeJobId ? () => void cancelCurrentOperation() : undefined}
              />
            )}

            {!uploadSessionActive && !busy && step === "upload" && (
              <Column gap="24">
                <Column gap="8">
                  <Text variant="label-default-s" onBackground="brand-medium">STEP 1 OF 5</Text>
                  <Heading id="step-title" tabIndex={-1} as="h1" variant="display-strong-s">Upload CSV data</Heading>
                    <Text variant="body-default-m" onBackground="neutral-weak">Choose one supported CSV. Files are removed when you finish or after {Math.round(capabilities.job_ttl_seconds / 3600)} hours.</Text>
                </Column>
                <Column role="note" fillWidth gap="8" padding="16" radius="m" background="brand-alpha-weak" border="brand-alpha-medium" className="workspace-notice">
                  <Text variant="label-strong-s">Private-network, temporary workspace</Text>
                  <Text variant="body-default-s">
                    This tool has no user accounts and must remain behind organization-approved network or identity controls. Files are retained temporarily, and generated work should be independently reviewed before legal use or external sharing.
                  </Text>
                </Column>
                <Panel className="upload-panel">
                  <Card
                    className="upload-dropzone"
                    role="button"
                    tabIndex={0}
                    aria-label="Choose a CSV file"
                    onClick={() => fileInput.current?.click()}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.current?.click(); } }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) chooseFile(file); }}
                  >
                    <Row center width="56" height="56" radius="full" background="brand-alpha-weak"><Icon name="document" onBackground="brand-medium" /></Row>
                    <Heading as="h2" variant="heading-strong-m">Drop your CSV here</Heading>
                    <Text variant="body-default-s" onBackground="neutral-weak">or click to browse · maximum {formatBytes(capabilities.max_upload_bytes)}</Text>
                    <span className="fake-button">Choose CSV</span>
                  </Card>
                </Panel>
              </Column>
            )}

            {!uploadSessionActive && busy && job && step === "upload" && (
              <UploadProgress
                file={uploadFile ?? (job.analysis ? { name: job.analysis.filename, size: job.analysis.size_bytes } : null)}
                stage={job.status === "analyzing" ? "analyzing" : "uploading"}
                percent={operationProgress}
                transferredBytes={uploadTransfer.loaded}
                transferBytes={uploadTransfer.total}
                phase={operationPhase}
                onCancel={() => void cancelCurrentOperation()}
              />
            )}

            {step === "data" && job?.analysis && (
              <Column gap="24">
                <Column gap="8">
                  <Text variant="label-default-s" onBackground="brand-medium">STEP 2 OF 5</Text>
                  <Heading id="step-title" tabIndex={-1} as="h1" variant="display-strong-s">{isBlocked ? "Review CSV problems" : "Choose the output"}</Heading>
                  <Text variant="body-default-m" onBackground="neutral-weak" className="platform-summary">{isBlocked ? "This CSV was analyzed, but it cannot be processed safely." : platformConfidenceSentence(job.analysis)}</Text>
                  <Text variant="body-default-s" onBackground="neutral-weak">{job.analysis.row_count.toLocaleString()} rows · {job.analysis.column_count.toLocaleString()} columns</Text>
                </Column>
                <ValidationResults analysis={job.analysis} detailed={isBlocked} />
                <PersonalDataNotice findings={job.analysis.personal_data_findings} />
                {!isBlocked && <WorkflowSelector value={selectedWorkflow} onChange={setSelectedWorkflow} />}
                <Panel>
                  <Row gap="24" wrap vertical="center">
                    <Column gap="4"><Text variant="label-default-xs" onBackground="neutral-weak">FILE</Text><Text variant="label-strong-s">{job.analysis.filename}</Text></Column>
                    <Column gap="4"><Text variant="label-default-xs" onBackground="neutral-weak">SIZE</Text><Text variant="label-strong-s">{formatBytes(job.analysis.size_bytes)}</Text></Column>
                    <Column gap="4"><Text variant="label-default-xs" onBackground="neutral-weak">CONTENT</Text><Text variant="label-strong-s">{job.analysis.detected_workflow === "rfp_ranges" ? "RFP data" : "Privilege data"}</Text></Column>
                    <Column gap="4"><Text variant="label-default-xs" onBackground="neutral-weak">SOURCE MATCH</Text><Tag variant="brand">{platformConfidenceLabel(job.analysis)}</Tag></Column>
                  </Row>
                  <Text variant="body-default-xs" onBackground="neutral-weak">Confidence is based on normalized column-name patterns. Filenames and row contents are not used.</Text>
                </Panel>
                <Row fillWidth horizontal="between" s={{ direction: "column", vertical: "stretch" }}>
                  <Button variant="secondary" onClick={() => requestNavigation("upload")}>Previous</Button>
                  {isBlocked
                    ? <Button variant="danger" prefixIcon="refresh" onClick={() => fileInput.current?.click()}>Choose another CSV</Button>
                    : <Button variant={hasWarnings ? "warning" : "primary"} onClick={confirmWorkflow} disabled={!selectedWorkflow} loading={busy}>{hasWarnings ? "Continue with warnings" : "Continue"}</Button>}
                </Row>
              </Column>
            )}

            {step === "advanced" && job?.analysis && (
              <Column gap="24">
                <Column gap="8">
                  <Text variant="label-default-s" onBackground="brand-medium">STEP 3 OF 5</Text>
                  <Heading id="step-title" tabIndex={-1} as="h1" variant="display-strong-s">{job.workflow === "rfp_ranges" ? "Inspect pleading ranges" : "Build privilege output"}</Heading>
                  <Text variant="body-default-m" onBackground="neutral-weak">{job.workflow === "rfp_ranges" ? "Review the ranges that will be grouped beneath each RFP heading in the text output." : "Arrange source fields into the exact output columns you need."}</Text>
                </Column>
                <ValidationResults
                  analysis={job.analysis}
                  acknowledged={acknowledged}
                  onToggle={(code) => { setAcknowledged((current) => current.includes(code) ? current.filter((item) => item !== code) : [...current, code]); setAdvancedDirty(true); }}
                  detailed
                />
                {job.workflow === "rfp_ranges" ? (
                  <Column gap="16">
                    <Grid columns="4" gap="16" m={{ columns: 2 }} s={{ columns: 1 }}>
                      {[
                        ["Prefixes", job.analysis.prefixes.length ? job.analysis.prefixes.join(", ") : "None"],
                        ["Requests", job.analysis.request_count.toLocaleString()],
                        ["Gaps preserved", job.analysis.gap_count.toLocaleString()],
                        ["Duplicates", job.analysis.duplicate_ranges.toLocaleString()],
                      ].map(([label, value]) => <Panel key={label}><Text variant="label-default-xs" onBackground="neutral-weak">{label.toUpperCase()}</Text><Heading as="p" variant="heading-strong-m">{value}</Heading></Panel>)}
                    </Grid>
                    <PleadingSettingsEditor settings={pleadingSettings} onChange={(settings) => { setPleadingSettingsState(settings); setAdvancedDirty(true); }} />
                  </Column>
                ) : (
                  <Column gap="16">
                    <TemplateManager headers={job.analysis.headers} columns={effectiveMappingColumns} templates={templates} onTemplatesChange={setTemplates} onApply={(columns, missing) => { setMappingColumns(columns); setAdvancedDirty(true); if (missing.length) setError(`Template fields not present in this CSV: ${missing.join(", ")}`); }} onError={setError} />
                    <MappingEditor headers={job.analysis.headers} columns={effectiveMappingColumns} onChange={(columns) => { setMappingColumns(columns); setAdvancedDirty(true); }} />
                  </Column>
                )}
                {advancedDirty && (
                  <Row role="status" fillWidth gap="8" padding="12" radius="m" background="warning-alpha-weak" border="warning-alpha-medium" vertical="center">
                    <Icon name="warning" onBackground="warning-medium" />
                    <Text variant="body-default-s">Unsaved changes. They are saved when you choose Review output.</Text>
                  </Row>
                )}
                <Row fillWidth horizontal="between" className="wizard-actions"><Button variant="secondary" onClick={() => requestNavigation("data")}>Previous</Button><Button variant={hasWarnings ? "warning" : "primary"} onClick={advanceFromAdvanced} disabled={!canAdvanceIssues || (job.workflow === "privilege_log" && !mappingIsReady)} loading={busy}>Review output</Button></Row>
              </Column>
            )}

            {step === "review" && job?.analysis && (
              <Column gap="24">
                <Column gap="8">
                  <Text variant="label-default-s" onBackground="brand-medium">STEP 4 OF 5</Text>
                  <Heading id="step-title" tabIndex={-1} as="h1" variant="display-strong-s">Review your output</Heading>
                  <Text variant="body-default-m" onBackground="neutral-weak">Confirm the filename and sample data before final processing.</Text>
                </Column>
                {hasWarnings && <ValidationResults analysis={job.analysis} detailed={false} />}
                <Panel>
                  <Input id="output-filename" label="Output filename" value={outputFilename} onChange={(event) => setOutputFilename(event.target.value.replace(/\.(csv|txt)$/i, ""))} hasSuffix={<Text variant="label-strong-s">{isTextOutput ? ".txt" : ".csv"}</Text>} />
                  <Row gap="8" wrap>
                    <Tag variant="brand">{preview?.total_rows.toLocaleString() ?? "—"} output rows</Tag>
                    <Tag variant={(preview?.skipped_rows ?? 0) > 0 ? "warning" : "neutral"}>{preview?.skipped_rows.toLocaleString() ?? "—"} skipped rows</Tag>
                    <Tag variant="neutral">{isTextOutput ? "Formatted plain text" : "Spreadsheet-safe output"}</Tag>
                  </Row>
                </Panel>
                <Panel>
                  <Row fillWidth horizontal="between" vertical="center"><Heading as="h2" variant="heading-strong-m">Sample output</Heading><Text variant="label-default-s" onBackground="neutral-weak">First five {isTextOutput ? "ranges" : "rows"}</Text></Row>
                  {busy && (
                    <Column gap="8">
                      <ProgressBar value={operationProgress} label />
                      <Text variant="body-default-s" onBackground="neutral-weak">{operationPhase}</Text>
                    </Column>
                  )}
                  {preview && (isTextOutput ? (
                    <pre className="text-preview">{preview.text || "No recoverable output ranges."}</pre>
                  ) : (
                    <div className="table-scroll"><Table fillWidth compact striped data={{ headers: preview.headers.map((header) => ({ content: header, key: header })), rows: preview.rows }} emptyState={<Text>No recoverable output rows.</Text>} /></div>
                  ))}
                </Panel>
                <Row fillWidth horizontal="between" className="wizard-actions"><Button variant="secondary" onClick={() => navigate("advanced")} disabled={busy}>Previous</Button>{busy ? <Button variant="danger" onClick={() => void cancelCurrentOperation()}>Cancel processing</Button> : <Button variant={hasWarnings ? "warning" : "success"} onClick={finalize} disabled={!outputFilename.trim()}>{hasWarnings ? "Finalize with warnings" : `Finalize ${isTextOutput ? "text file" : "CSV"}`}</Button>}</Row>
              </Column>
            )}

            {step === "download" && job?.output_stats && (
              <Column gap="24">
                <Column gap="8" horizontal="center">
                  <Row center width="64" height="64" radius="full" background="success-alpha-weak"><Icon name="check" size="l" onBackground="success-medium" /></Row>
                  <Text variant="label-default-s" onBackground="success-medium">STEP 5 OF 5 · COMPLETE</Text>
                  <Heading id="step-title" tabIndex={-1} as="h1" variant="display-strong-s" align="center">Your {isTextOutput ? "text file" : "CSV"} is ready</Heading>
                  <Text variant="body-default-m" onBackground="neutral-weak" align="center">Download it now. This workspace remains available until {new Date(job.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</Text>
                </Column>
                <Panel>
                  <Row fillWidth horizontal="between" vertical="center" s={{ direction: "column", vertical: "stretch" }}>
                    <Column gap="4"><Heading as="h2" variant="heading-strong-m">{job.output_filename}</Heading><Text variant="body-default-s" onBackground="neutral-weak">{formatBytes(job.output_stats.output_size_bytes)} · {job.output_stats.output_rows.toLocaleString()} rows</Text></Column>
                    <Row gap="8" wrap>
                      <Button href={`/api/v1/jobs/${job.job_id}/download`} prefixIcon="download" size="l">Download {isTextOutput ? "text file" : "CSV"}</Button>
                      <Button href={`/api/v1/jobs/${job.job_id}/receipt.json`} variant="secondary">JSON receipt</Button>
                      <Button href={`/api/v1/jobs/${job.job_id}/receipt.txt`} variant="secondary">Text receipt</Button>
                      <Button href={`/api/v1/jobs/${job.job_id}/evidence.zip`} variant="secondary">Evidence package</Button>
                    </Row>
                  </Row>
                  <Grid columns="4" gap="16" m={{ columns: 2 }} s={{ columns: 1 }}>
                    {[
                      ["Processing", `${job.output_stats.processing_ms.toLocaleString()} ms`],
                      ["Cells written", job.output_stats.output_cells.toLocaleString()],
                      ["Rows skipped", job.output_stats.skipped_rows.toLocaleString()],
                      ["Safety escapes", job.output_stats.formula_escapes.toLocaleString()],
                    ].map(([label, value]) => <Column key={label} gap="4" padding="16" radius="m" background="neutral-alpha-weak"><Text variant="label-default-xs" onBackground="neutral-weak">{label.toUpperCase()}</Text><Text variant="heading-strong-s">{value}</Text></Column>)}
                  </Grid>
                </Panel>
                <Row fillWidth horizontal="between" s={{ direction: "column" }}><Button variant="secondary" onClick={() => startAgain(false)} prefixIcon="refresh">Process another CSV</Button><Button variant="tertiary" onClick={() => startAgain(true)}>Finish</Button></Row>
              </Column>
            )}
          </div>
        </Column>
      </Column>
      <AppFooter />
    </Column>
  );
}
