import { z } from "zod";
import { ProblemResponse } from "./common.ts";

export const WithdrawalTarget = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("event"), id: z.string().trim().min(1).max(120) }),
    z.strictObject({ type: z.literal("story"), id: z.uuid() }),
    z.strictObject({
      type: z.literal("report"),
      lane: z.enum(["news", "policy"]).default("news"),
      kind: z.enum(["daily", "weekly", "monthly"]),
      key: z.string().trim().min(1).max(64),
    }),
  ])
  .superRefine((target, ctx) => {
    if (target.type === "report" && target.lane === "policy" && target.kind === "daily")
      ctx.addIssue({ code: "custom", message: "法规报告只支持周报和月报。" });
  });
const RecordId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SnapshotHash = z.string().regex(/^[a-f0-9]{64}$/);
const Reason = z.string().trim().min(1).max(2000);
export const WithdrawalPreviewRequest = z.strictObject({ target: WithdrawalTarget });
export const WithdrawalPreviewResponse = z.strictObject({
  target: WithdrawalTarget,
  memberIds: z.array(z.string()),
  memberCount: z.number().int().nonnegative(),
  activeRecords: z.array(
    z.strictObject({ withdrawalId: RecordId, reason: Reason, createdAt: z.iso.datetime({ offset: true }), memberCount: z.number().int().nonnegative() }),
  ),
  snapshotHash: SnapshotHash,
});
export const WithdrawalActionRequest = z
  .strictObject({
    target: WithdrawalTarget,
    action: z.enum(["withdraw", "restore"]),
    reason: Reason,
    expectedSnapshotHash: SnapshotHash,
    withdrawalId: RecordId.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "restore" && !value.withdrawalId) ctx.addIssue({ code: "custom", path: ["withdrawalId"], message: "恢复须指定独立下架记录。" });
    if (value.action === "withdraw" && value.withdrawalId !== undefined)
      ctx.addIssue({ code: "custom", path: ["withdrawalId"], message: "新增下架不应携带旧记录。" });
  });
export const WithdrawalActionResponse = z.strictObject({
  withdrawalId: RecordId,
  action: z.enum(["withdraw", "restore"]),
  affectedItems: z.number().int().nonnegative(),
});
export const withdrawalSchemas = { WithdrawalTarget, WithdrawalPreviewRequest, WithdrawalPreviewResponse, WithdrawalActionRequest, WithdrawalActionResponse };
const errors = { 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 404: ProblemResponse, 409: ProblemResponse, 503: ProblemResponse };
export const withdrawalRoutes = {
  previewWithdrawal: {
    method: "POST" as const,
    url: "/api/admin/withdrawals/preview",
    schema: { operationId: "previewWithdrawal", body: WithdrawalPreviewRequest, response: { 200: WithdrawalPreviewResponse, ...errors } },
  },
  actWithdrawal: {
    method: "POST" as const,
    url: "/api/admin/withdrawals/actions",
    schema: { operationId: "actWithdrawal", body: WithdrawalActionRequest, response: { 200: WithdrawalActionResponse, ...errors } },
  },
};
