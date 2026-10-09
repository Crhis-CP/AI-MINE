import { z } from "zod";
import { ProblemResponse } from "./common.ts";
const text = z.string().trim().min(1),
  time = z.iso.datetime({ offset: true }),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SelectionToolState = z.strictObject({ enabled: z.boolean(), expiresAt: time.nullable(), revision: z.number().int().nonnegative() });
export const SelectionCommand = z.strictObject({ requestId: z.uuid(), expectedRevision: z.number().int().nonnegative() });
export const SelectionToolRequest = SelectionCommand.extend({ enabled: z.boolean(), expiresAt: time.nullable(), reason: text.max(2000) });
export const SelectionLabelRequest = SelectionCommand.extend({
  sampleRevision: z.number().int().positive(),
  decision: z.enum(["select", "reject", "either"]),
  note: z.string().max(4000),
});
export const SelectionLabel = z.strictObject({
  decision: z.enum(["select", "reject", "either"]),
  note: z.string(),
  revision: z.number().int().positive(),
  actor: z.string(),
  at: time,
});
export const SelectionSample = z.strictObject({
  datasetId: text,
  caseId: text,
  sampleRevision: z.number().int().positive(),
  split: z.enum(["development", "holdout"]),
  stratum: z.string().nullable(),
  scorerInput: z.string(),
  materialCurrent: z.boolean(),
  synthetic: z.boolean(),
  label: SelectionLabel.nullable(),
});
export const SelectionSamples = z.strictObject({
  datasetId: z.string().nullable(),
  datasetLabel: z.string().nullable(),
  synthetic: z.boolean(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  samples: z.array(SelectionSample),
});
export const SelectionModelIdentity = z.strictObject({
  model: text,
  configurationHash: hash.nullable(),
  state: z.enum(["known", "unknown"]),
  reason: z.string().nullable(),
});
export const SelectionSubmission = z.strictObject({
  id: text,
  standardVersion: text,
  contentHash: hash,
  prefilterVersion: text,
  thresholdVersion: hash,
  submittedAt: time,
  materialReference: text,
  changeNote: z.string(),
  synthetic: z.boolean(),
});
export const SelectionRecord = z.strictObject({
  id: text,
  kind: z.enum(["standard_review", "holdout", "calibration"]),
  standardVersion: text,
  prefilterVersion: text,
  thresholdVersion: hash,
  contentHash: hash,
  status: z.enum(["approved", "changes_requested", "rejected", "confirmed"]),
  actor: text,
  at: time,
  note: z.string(),
  submissionId: z.string().nullable(),
  runId: z.string().nullable(),
  model: z.string().nullable(),
  modelConfigurationHash: hash.nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  accuracy: z.number().nullable(),
  precision: z.number().nullable(),
  recall: z.number().nullable(),
  mistakes: z.number().int().nonnegative().nullable(),
  synthetic: z.boolean(),
});
export const SelectionStandardReview = SelectionCommand.omit({ expectedRevision: true })
  .extend({
    submissionId: text,
    standardVersion: text,
    contentHash: hash,
    readComparison: z.literal(true),
    decision: z.enum(["approved", "changes_requested", "rejected"]),
    note: z.string().max(4000),
  })
  .superRefine((v, c) => {
    if (v.decision === "changes_requested" && !v.note.trim()) c.addIssue({ code: "custom", message: "请写明修改意见" });
  });
export const SelectionHoldoutConfirm = SelectionCommand.omit({ expectedRevision: true }).extend({
  runId: text,
  model: text,
  evidenceHash: hash,
  note: z.string().max(4000),
});
export const SelectionCalibrationSummary = z.strictObject({
  runId: text,
  label: text,
  split: z.string().nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  model: text,
  standardVersion: z.string().nullable(),
  prefilterVersion: z.string().nullable(),
  thresholdVersion: hash.nullable(),
  modelConfigurationHash: hash.nullable(),
  datasetVersion: hash.nullable(),
  accuracy: z.number().nullable(),
  precision: z.number().nullable(),
  recall: z.number().nullable(),
  mistakes: z.number().int().nonnegative().nullable(),
  ranAt: time,
  ownerConfirmedAt: time.nullable(),
  synthetic: z.boolean(),
  origin: z.enum(["trusted_runner", "legacy_or_upload"]),
});
export const SelectionStandards = z.strictObject({
  tool: SelectionToolState,
  current: z.strictObject({
    standardVersion: text,
    contentHash: hash,
    prefilterVersion: text,
    thresholdVersion: hash,
    thresholds: z.record(z.string(), z.number()),
    text: z.string(),
    prefilterText: z.string(),
    deploymentConfirmedVersion: z.string().nullable(),
    configuredForCurrent: z.boolean(),
    effectiveAt: time.nullable(),
    model: SelectionModelIdentity,
  }),
  submission: SelectionSubmission.nullable(),
  reviewStatus: z.enum(["draft", "submitted", "approved", "changes_requested", "rejected"]),
  records: z.array(SelectionRecord),
  calibrations: z.array(SelectionCalibrationSummary),
  checks: z.strictObject({ ownerStandardReview: z.boolean(), ownerHoldout: z.boolean(), versionsMatch: z.boolean(), ready: z.boolean() }),
  missing: z.array(z.string()),
});
export const SelectionRunEvidence = z.strictObject({
  runId: text,
  standardVersion: z.string().nullable(),
  prefilterVersion: z.string().nullable(),
  thresholdVersion: hash.nullable(),
  modelConfigurations: z.record(z.string(), hash.nullable()),
  datasetId: z.string().nullable(),
  datasetVersion: hash.nullable(),
  synthetic: z.boolean(),
  origin: z.enum(["trusted_runner", "legacy_or_upload"]),
  missing: z.array(z.string()),
  models: z.array(z.strictObject({ model: text, evidenceHash: hash, confirmable: z.boolean(), missing: z.array(z.string()) })),
});
export const selectionCalibrationSchemas = {
  SelectionToolState,
  SelectionToolRequest,
  SelectionLabelRequest,
  SelectionLabel,
  SelectionSample,
  SelectionSamples,
  SelectionModelIdentity,
  SelectionSubmission,
  SelectionRecord,
  SelectionStandardReview,
  SelectionHoldoutConfirm,
  SelectionStandards,
  SelectionCalibrationSummary,
  SelectionRunEvidence,
};
const errors = {
  400: ProblemResponse,
  401: ProblemResponse,
  403: ProblemResponse,
  404: ProblemResponse,
  409: ProblemResponse,
  500: ProblemResponse,
  503: ProblemResponse,
};
export const selectionCalibrationRoutes = {
  selectionStandards: {
    method: "GET" as const,
    url: "/api/admin/selectbench/standards",
    schema: { operationId: "selectionStandards", response: { 200: SelectionStandards, ...errors } },
  },
  selectionTool: {
    method: "GET" as const,
    url: "/api/admin/selectbench/control",
    schema: { operationId: "selectionTool", response: { 200: SelectionToolState, ...errors } },
  },
  selectionToolChange: {
    method: "POST" as const,
    url: "/api/admin/selectbench/control",
    schema: { operationId: "selectionToolChange", body: SelectionToolRequest, response: { 200: SelectionToolState, ...errors } },
  },
  selectionSamples: {
    method: "GET" as const,
    url: "/api/admin/selectbench/samples",
    schema: {
      operationId: "selectionSamples",
      querystring: z.strictObject({ datasetId: z.string().optional(), page: z.coerce.number().int().min(1).optional() }),
      response: { 200: SelectionSamples, ...errors },
    },
  },
  selectionLabel: {
    method: "POST" as const,
    url: "/api/admin/selectbench/samples/:datasetId/:caseId",
    schema: {
      operationId: "selectionLabel",
      params: z.strictObject({ datasetId: text, caseId: text }),
      body: SelectionLabelRequest,
      response: { 200: SelectionLabel, ...errors },
    },
  },
  selectionReview: {
    method: "POST" as const,
    url: "/api/admin/selectbench/standard-review",
    schema: { operationId: "selectionReview", body: SelectionStandardReview, response: { 200: SelectionRecord, ...errors } },
  },
  selectionHoldout: {
    method: "POST" as const,
    url: "/api/admin/selectbench/holdout-confirm",
    schema: { operationId: "selectionHoldout", body: SelectionHoldoutConfirm, response: { 200: SelectionRecord, ...errors } },
  },
  selectionRunEvidence: {
    method: "GET" as const,
    url: "/api/admin/selectbench/:id/evidence",
    schema: { operationId: "selectionRunEvidence", params: z.strictObject({ id: text }), response: { 200: SelectionRunEvidence, ...errors } },
  },
};
