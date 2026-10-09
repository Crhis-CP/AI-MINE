import type { FastifyInstance } from "fastify";
import { routes } from "@amp/contracts/http/private";
import {
  selectionStandards,
  selectionTool,
  changeSelectionTool,
  selectionSamples,
  labelSelectionSample,
  reviewSelectionStandard,
  confirmSelectionHoldout,
  selectionRunEvidence,
} from "@amp/backend/admin/selectbench";
import { adminHandler, type AdminHandler } from "./admin-auth.ts";
import { sendProblem } from "../http/respond.ts";
const handler = (fn: AdminHandler) =>
  adminHandler(async (req, reply, principal) => {
    try {
      return await fn(req, reply, principal);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 503)
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "校准记录暂时不可读取，请稍后重试。" });
      throw error;
    }
  });
export function registerSelectionCalibration(app: FastifyInstance) {
  app.get(
    routes.selectionStandards.url,
    routes.selectionStandards,
    handler(async (_req, _reply, p) => selectionStandards(p)),
  );
  app.get(
    routes.selectionTool.url,
    routes.selectionTool,
    handler(async (_req, _reply, p) => selectionTool(p)),
  );
  app.post(
    routes.selectionToolChange.url,
    routes.selectionToolChange,
    handler(async (req, _reply, p) => changeSelectionTool(req.body, p)),
  );
  app.get(
    routes.selectionSamples.url,
    routes.selectionSamples,
    handler(async (req, _reply, p) => selectionSamples(p, (req.query as { datasetId?: string }).datasetId, (req.query as { page?: number }).page ?? 1)),
  );
  app.post(
    routes.selectionLabel.url,
    routes.selectionLabel,
    handler(async (req, _reply, p) => {
      const v = req.params as { datasetId: string; caseId: string };
      return labelSelectionSample(v.datasetId, v.caseId, req.body, p);
    }),
  );
  app.post(
    routes.selectionReview.url,
    routes.selectionReview,
    handler(async (req, _reply, p) => reviewSelectionStandard(req.body, p)),
  );
  app.post(
    routes.selectionHoldout.url,
    routes.selectionHoldout,
    handler(async (req, _reply, p) => confirmSelectionHoldout(req.body, p)),
  );
  app.get(
    routes.selectionRunEvidence.url,
    routes.selectionRunEvidence,
    handler(async (req, _reply, p) => selectionRunEvidence((req.params as { id: string }).id, p)),
  );
}
