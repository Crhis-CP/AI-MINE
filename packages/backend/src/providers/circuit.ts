import { randomUUID } from "node:crypto";
import { sql, type Db } from "../db.ts";
import { ProviderRejectedError } from "./receipts.ts";

const WINDOW_MS = 5 * 60_000;
const FAILURE_LIMIT = 10;
export type ModelCircuit = { failures: number; firstFailureAt: number; openUntil: number; probe: string | null; probeUntil: number };
const closed = (): ModelCircuit => ({ failures: 0, firstFailureAt: 0, openUntil: 0, probe: null, probeUntil: 0 });
export interface CircuitPermit {
  probe: string | null;
}
export class CircuitOpenError extends ProviderRejectedError {
  readonly retryAfterSeconds: number;
  readonly evidence: { service: string; observedAt: number; state: ModelCircuit };
  constructor(service: string, state: ModelCircuit) {
    super("模型服务暂时不可用，正在等待恢复", 503, true, "connect_before_send");
    const observedAt = Date.now();
    this.evidence = { service, observedAt, state: { ...state } };
    this.retryAfterSeconds = Math.max(1, Math.ceil((Math.max(state.openUntil, state.probeUntil) - observedAt) / 1000));
  }
}

/** Admission runs under the receipt transaction and its service lock, only for a new paid attempt. */
export async function enterModelCircuit(tx: Db, service: string, timeoutMs: number): Promise<CircuitPermit> {
  await tx`INSERT INTO ai.model_service_circuits(service,state) VALUES(${service},${tx.json(closed())}) ON CONFLICT DO NOTHING`;
  const [row] = await tx<{ state: ModelCircuit }[]>`SELECT state FROM ai.model_service_circuits WHERE service=${service} FOR UPDATE`;
  const state = row!.state;
  if (!state.openUntil) return { probe: null };
  const now = Date.now();
  if (state.openUntil > now || state.probeUntil > now) throw new CircuitOpenError(service, state);
  state.probe = randomUUID();
  state.probeUntil = now + timeoutMs;
  await tx`UPDATE ai.model_service_circuits SET state=${tx.json(state)},updated_at=now() WHERE service=${service}`;
  return { probe: state.probe };
}

/** Cached responses and local guard failures never report provider health. */
export async function recordModelHealth(service: string, permit: CircuitPermit, unavailable: boolean): Promise<void> {
  await sql.begin(async (tx) => {
    const [row] = await tx<{ state: ModelCircuit }[]>`SELECT state FROM ai.model_service_circuits WHERE service=${service} FOR UPDATE`;
    const state = row!.state;
    if (state.openUntil && (!permit.probe || state.probe !== permit.probe)) return;
    if (!state.openUntil && permit.probe) return;
    if (!unavailable) {
      if (state.failures || state.openUntil)
        await tx`UPDATE ai.model_service_circuits SET state=${tx.json(closed())},updated_at=now() WHERE service=${service}`;
      return;
    }
    const now = Date.now();
    if (!state.firstFailureAt || now - state.firstFailureAt > WINDOW_MS) {
      state.firstFailureAt = now;
      state.failures = 0;
    }
    state.failures++;
    if (permit.probe || state.failures >= FAILURE_LIMIT) state.openUntil = now + WINDOW_MS;
    state.probe = null;
    state.probeUntil = 0;
    await tx`UPDATE ai.model_service_circuits SET state=${tx.json(state)},updated_at=now() WHERE service=${service}`;
  });
}

export async function modelCircuits(db: Db = sql): Promise<Record<string, ModelCircuit>> {
  const rows = await db<{ service: string; state: ModelCircuit }[]>`SELECT service,state FROM ai.model_service_circuits`;
  return Object.fromEntries(rows.map((row) => [row.service, row.state]));
}
