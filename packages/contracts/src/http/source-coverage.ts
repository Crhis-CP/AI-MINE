import { z } from "zod";
import { ProblemResponse } from "./common.ts";
const axis = z.strictObject({ id: z.string(), label: z.string() });
export const SourceCoverageEntry = z.strictObject({
  id: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  kind: z.enum(["target", "directory"]),
  sourceIds: z.array(z.string()),
  note: z.string().nullable(),
  identity: z.enum(["unverified", "verified"]),
});
export const SourceCoverageMatrix = z.strictObject({
  id: z.enum(["china", "news", "policy"]),
  title: z.string(),
  explanation: z.string(),
  rows: z.array(axis),
  columns: z.array(axis),
  cells: z.array(
    z.strictObject({
      row: z.string(),
      column: z.string(),
      entries: z.array(SourceCoverageEntry),
      configured: z.number().int().nonnegative(),
      observed: z.number().int().nonnegative(),
    }),
  ),
});
export const SourceCoverage = z.strictObject({
  asOf: z.iso.datetime({ offset: true }),
  matrices: z.array(SourceCoverageMatrix),
  supplemental: z.array(z.strictObject({ id: z.string(), name: z.string(), lane: z.enum(["news", "policy"]), enabled: z.boolean() })),
  limitations: z.array(z.string()),
});
export const SourceTargetExport = z.strictObject({
  filename: z.string(),
  content: z.string().max(2_000_000),
  asOf: z.iso.datetime({ offset: true }),
  total: z.number().int().nonnegative(),
});
export const sourceCoverageSchemas = { SourceCoverageEntry, SourceCoverageMatrix, SourceCoverage, SourceTargetExport };
const errors = { 401: ProblemResponse, 403: ProblemResponse, 503: ProblemResponse };
export const sourceCoverageRoutes = {
  sourceCoverage: {
    method: "GET" as const,
    url: "/api/admin/source-coverage",
    schema: { operationId: "sourceCoverage", response: { 200: SourceCoverage, ...errors } },
  },
  exportSourceTargets: {
    method: "POST" as const,
    url: "/api/admin/source-targets/export",
    schema: { operationId: "exportSourceTargets", body: z.strictObject({}), response: { 200: SourceTargetExport, 400: ProblemResponse, ...errors } },
  },
};
