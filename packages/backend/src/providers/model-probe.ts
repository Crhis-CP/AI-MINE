import { z } from "zod";
import type { PgBoss } from "pg-boss";
import { dbOf } from "../db.ts";
import { chatJson, type RegisteredModelTransport } from "./llm.ts";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, completeReceipt } from "./receipts.ts";
import { modelRegistryLock, connectionRow, registeredModelKey } from "./model-registry.ts";
import { modelProbeRecord } from "../admin/model-registry.ts";
import { audit } from "../admin/auth.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import {
  RuntimeControlPaused,
  RuntimeControlStale,
  requireRuntimeRunning,
  assertRuntimeControl,
  type RuntimeControlSnapshot,
} from "../operations/lane-controls.ts";
import { config } from "../config.ts";
import { enqueue, ensureQueue } from "../jobs/queue.ts";
const sql = dbOf("ai-gateway");
const queues = { news: "news.model-test", policy: "policy.model-test" } as const;
const knownUsage = (usage: Record<string, unknown> | null) =>
  [usage?.prompt_tokens, usage?.completion_tokens].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
/** Called only by worker. Recovery consumes the same receipt; no automatic new physical request. */
export async function runModelConnectionProbe(id: string, options: { transport?: RegisteredModelTransport } = {}) {
  const test = await modelProbeRecord(id);
  if (["passed", "failed", "unknown"].includes(test.status)) return test;
  let snapshot: RuntimeControlSnapshot;
  try {
    if (!config.modelCallsEnabled) throw new RuntimeControlPaused("模型调用已暂停");
    snapshot = await sql.begin(async (tx) => requireRuntimeRunning(test.lane, ["processing"], tx));
    await sql`UPDATE ai.model_connection_tests SET status='running',detail=NULL WHERE id=${id} AND status IN ('queued','paused')`;
    const result = await chatJson({
      model: registeredModelKey(test.connection_id),
      registeredProbe: { probeId: id, revision: test.revision },
      registeredTransport: options.transport,
      purpose: "model_connection_test",
      subject: `model-test:${id}`,
      promptVersion: promptVersion("model-connection-test/system"),
      system: promptText("model-connection-test/system"),
      user: id,
      schema: z.strictObject({ ok: z.literal(true) }),
      temperature: 0,
      maxTokens: 32,
      usagePurpose: "experiment",
      lane: test.lane,
      timeoutMs: 30_000,
      beforeRequest: async () => {
        await sql.begin(async (tx) => {
          await assertRuntimeControl(tx, snapshot);
        });
      },
    });
    const passed = knownUsage(result.usage) && result.finishReason === "stop";
    await sql.begin(async (tx) => {
      await modelRegistryLock(tx);
      const row = await connectionRow(test.connection_id, tx),
        current = row.revision === test.revision && row.enabled;
      await tx`UPDATE ai.model_connection_tests SET status=${!knownUsage(result.usage) ? "unknown" : passed && current ? "passed" : "failed"},detail=${!knownUsage(result.usage) ? "已收到结果，但计费用量缺失，须核对回执" : !current ? "配置已变化，当前版本须重新测试" : passed ? null : "结果不完整"},receipt_id=${result.receiptId},attempt_id=${result.attemptId},finished_at=now() WHERE id=${id}`;
      if (passed && current) {
        await assertRuntimeControl(tx, snapshot);
        await tx`UPDATE ai.model_connections SET passed_revision=${test.revision},tested_at=now() WHERE id=${test.connection_id} AND revision=${test.revision}`;
        await completeReceipt(tx, result.receiptId);
      }
      await audit(
        "worker:model-test",
        "models.connection.test_result",
        test.connection_id,
        "连接测试",
        null,
        { testId: id, passed: passed && current, known_usage: knownUsage(result.usage), receiptId: result.receiptId },
        undefined,
        tx,
      );
    });
  } catch (error) {
    if (error instanceof ReceiptBusyError) return modelProbeRecord(id);
    const [receipt] = await sql<
      { id: string; status: string; attempt_id: string | null; usage: Record<string, unknown> | null }[]
    >`SELECT r.id::text,r.status,coalesce(r.response_attempt_id,(SELECT a.id FROM receipt_attempts a WHERE a.receipt_id=r.id AND a.attempt=r.attempts))::text AS attempt_id,r.usage FROM receipts r WHERE r.purpose='model_connection_test' AND r.subject=${`model-test:${id}`} ORDER BY r.id DESC LIMIT 1`;
    const unknown =
      receipt && (["unknown", "pending"].includes(receipt.status) || (["received", "completed"].includes(receipt.status) && !knownUsage(receipt.usage)));
    const paused = !unknown && (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale || error instanceof BudgetExceededError);
    const status = unknown ? "unknown" : paused ? "paused" : "failed";
    const detail = unknown
      ? "调用结果或计费用量未知，须核对原回执，不能重发"
      : paused
        ? "模型处理或付费请求已暂停"
        : error instanceof ProviderRejectedError && error.status === 401
          ? "密钥无效"
          : "连接测试未通过，请核对配置或服务状态";
    await sql`UPDATE ai.model_connection_tests SET status=${status},detail=${detail},receipt_id=${receipt?.id ?? null},attempt_id=${receipt?.attempt_id ?? null},finished_at=${paused ? null : new Date()} WHERE id=${id} AND status<>'passed'`;
  }
  return modelProbeRecord(id);
}
/** Enqueue is separate from durable creation so retrying a failed enqueue never creates another test. */
export async function queueModelConnectionProbe(request: { id: string; lane: "news" | "policy"; status: string }) {
  const test = await modelProbeRecord(request.id);
  if (!["queued", "running", "paused"].includes(test.status)) return;
  await ensureQueue(queues[test.lane]);
  await enqueue(queues[test.lane], { id: test.id, lane: test.lane }, { singletonKey: test.id, retryLimit: 0 });
}
export async function registerModelConnectionProbeJobs(boss: PgBoss, options: { transport?: RegisteredModelTransport } = {}) {
  for (const lane of ["news", "policy"] as const) {
    await ensureQueue(queues[lane]);
    await boss.work<{ id: string; lane: "news" | "policy" }>(queues[lane], async (jobs) => {
      for (const job of jobs)
        if (job.data.lane === lane && (await modelProbeRecord(job.data.id)).lane === lane) await runModelConnectionProbe(job.data.id, options);
    });
  }
}

/** Re-enqueue the existing durable test, preserving the exact logical receipt and physical-attempt evidence. */
export async function sweepModelConnectionProbes() {
  const rows = await sql<
    { id: string; lane: "news" | "policy"; status: string }[]
  >`SELECT id,lane,status FROM ai.model_connection_tests WHERE status IN ('queued','paused','running') ORDER BY created_at LIMIT 50`;
  for (const row of rows) await queueModelConnectionProbe(row);
  return rows.length;
}
