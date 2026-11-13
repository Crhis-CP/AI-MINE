// How much money is left in the model account (TASK-0631). Read from the provider's own balance page for accounts that
// offer one, so the Owner hears "about three days left" before the account runs dry instead of after (TASK-0630).
import { sql } from "../db.ts";
import { credential } from "../config.ts";
import { MODELS } from "./llm.ts";
import { registeredModelKey, resolveRegisteredModel } from "./model-registry.ts";

/** Providers whose balance can be read with the same key that pays for the calls. The request is free. */
const READERS: Record<string, { host: string; url: string; read: (json: unknown) => number | null }> = {
  deepseek: { host: "api.deepseek.com", url: "https://api.deepseek.com/user/balance", read: deepseekBalance },
};

export const BALANCE_SETTING = "models.balance";
/** Warn while what is left pays for fewer days than this at the recent daily spend. */
export const BALANCE_WARN_DAYS = 3;
/** With no spend on record yet, warn below this many yuan. */
export const BALANCE_FLOOR_YUAN = 5;
/** A reading older than this says nothing about now. */
export const BALANCE_FRESH_MS = 3 * 3600_000;

export interface BalanceReading {
  /** Yuan left, summed over the provider's accounts in use. */
  yuan: number;
  at: string;
}
export type BalanceState = Record<string, BalanceReading>;

/** DeepSeek: {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00",...}]}. Only CNY is counted. */
export function deepseekBalance(json: unknown): number | null {
  const infos = (json as { balance_infos?: unknown })?.balance_infos;
  if (!Array.isArray(infos)) return null;
  const cny = infos.filter((i) => i?.currency === "CNY" && /^-?\d+(\.\d+)?$/.test(String(i?.total_balance)));
  return cny.length ? cny.reduce((sum, i) => sum + Number(i.total_balance), 0) : null;
}

const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** The distinct keys in use per provider: the models set in the environment and the connections registered in the admin. */
async function keysInUse(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const add = (base: string | null | undefined, key: string | null | undefined) => {
    const host = hostOf(base);
    const service = Object.keys(READERS).find((s) => READERS[s]!.host === host);
    if (service && key) out.set(service, (out.get(service) ?? new Set()).add(key));
  };
  for (const spec of Object.values(MODELS)) {
    try {
      add(credential("models", spec.baseUrlEnv), credential("models", spec.apiKeyEnv));
    } catch {
      // A preset without credentials is simply not in use.
    }
  }
  const registered = await sql<{ id: string }[]>`SELECT id FROM ai.model_connections WHERE enabled AND passed_revision = revision`.catch(() => []);
  for (const row of registered) {
    try {
      const model = await resolveRegisteredModel(registeredModelKey(row.id));
      if (model) add(model.baseUrl, model.apiKey);
    } catch {
      // Stopped or changed between the two reads.
    }
  }
  return out;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * Every 30 minutes: ask each provider that offers it how much is left and keep the answer. A provider that does not answer
 * keeps its earlier reading, which goes stale by itself; nothing here stops or changes any processing.
 */
export async function readAccountBalances(options: { fetch?: Fetch; now?: number } = {}): Promise<BalanceState> {
  const ask = options.fetch ?? (fetch as unknown as Fetch);
  const now = options.now ?? Date.now();
  const found: BalanceState = {};
  for (const [service, keys] of await keysInUse()) {
    let yuan = 0;
    let complete = true;
    for (const key of keys) {
      try {
        const res = await ask(READERS[service]!.url, {
          headers: { accept: "application/json", authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        });
        const left = res.ok ? READERS[service]!.read(await res.json()) : null;
        if (left === null) complete = false;
        else yuan += left;
      } catch {
        complete = false;
      }
    }
    if (complete) found[service] = { yuan: Math.round(yuan * 100) / 100, at: new Date(now).toISOString() };
  }
  if (Object.keys(found).length)
    await sql`INSERT INTO settings(key, value) VALUES('models.balance', ${sql.json(found as never)})
      ON CONFLICT(key) DO UPDATE SET value = settings.value || EXCLUDED.value`;
  return found;
}

/** Average yuan a day over the last seven full Beijing days that have any spend on record; null when there is none. */
export async function recentDailySpend(now = Date.now()): Promise<number | null> {
  const day = (offset: number) => new Date(now + 8 * 3600_000 - offset * 86400_000).toISOString().slice(0, 10);
  const rows = await sql<{ amount: string }[]>`
    SELECT (settled_micros + unknown_micros)::text AS amount FROM ai.usage_sums
    WHERE kind = 'day' AND key >= ${day(7)} AND key <= ${day(1)} AND settled_micros + unknown_micros > 0`;
  if (!rows.length) return null;
  return rows.reduce((sum, r) => sum + Number(r.amount), 0) / rows.length / 1_000_000;
}

export interface LowBalance {
  service: string;
  yuan: number;
  /** Days the balance lasts at the recent daily spend; null when there is no spend on record. */
  days: number | null;
  daily: number | null;
}

/** The accounts that are about to run dry, from fresh readings only. */
export async function lowBalances(now = Date.now()): Promise<LowBalance[]> {
  const [row] = await sql<{ value: BalanceState }[]>`SELECT value FROM settings WHERE key = 'models.balance'`;
  const daily = await recentDailySpend(now);
  const out: LowBalance[] = [];
  for (const [service, reading] of Object.entries(row?.value ?? {})) {
    if (!(now - Date.parse(reading.at) < BALANCE_FRESH_MS)) continue;
    const days = daily && daily > 0 ? reading.yuan / daily : null;
    if (days !== null ? days < BALANCE_WARN_DAYS : reading.yuan < BALANCE_FLOOR_YUAN) out.push({ service, yuan: reading.yuan, days, daily });
  }
  return out;
}
