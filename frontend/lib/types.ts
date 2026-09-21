/**
 * @file Frontend aliases and refinements for generated OpenAPI schema types.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import type { components } from "./api-schema";

type Schema = components["schemas"];

export type Workflow = Schema["WorkflowUpdate"]["workflow"];
export type TransformKind = Schema["MappingTransform"]["kind"];
export type Issue = Required<Schema["Issue"]>;
export type PersonalDataFinding = Schema["PersonalDataFinding"];
export type Analysis = Omit<Required<Schema["Analysis"]>, "issues"> & { issues: Issue[] };
export type OutputColumn = Omit<Required<Schema["OutputColumn"]>, "transform"> & {
  transform: Required<Schema["MappingTransform"]>;
};
export type MappingConfig = { columns: OutputColumn[] };
export type PleadingSettings = Required<Schema["PleadingSettings"]>;
type OutputStats = Schema["OutputStats"];
export type Preview = Schema["Preview"];

type JobStatus = Schema["JobStatus"];
export type Job = Omit<Required<Schema["JobView"]>, "status" | "analysis" | "mapping" | "pleading_settings" | "output_stats"> & {
  status: JobStatus;
  analysis: Analysis | null;
  mapping: MappingConfig | null;
  pleading_settings: PleadingSettings | null;
  output_stats: OutputStats | null;
  error_code: string | null;
  cancel_requested: boolean;
  revision: number;
};

export type Capabilities = {
  max_upload_bytes: number;
  job_ttl_seconds: number;
  max_active_jobs: number;
  max_total_job_bytes: number;
  supported_content_types: string[];
  features: string[];
};

export type MappingTemplate = {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  columns: OutputColumn[];
};
