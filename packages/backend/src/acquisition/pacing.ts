import { randomUUID } from "node:crypto";
import { evaluateSourcePolicy, lockCurrentSourcePolicies } from "@amp/backend/admin/sources";
import { dbOf, type Tx } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
const sql = dbOf("acquisition");
export type CrawlProof = {
  sourceId: string;
  lane: "news" | "policy";
  permissionVersion: number;
  url: string;
  documentType: string | null;
  attachment: boolean;
  fulltext: boolean;
};
async function lockProof(tx: Tx, proof?: CrawlProof) {
  if (!proof) return;
  await lockCurrentSourcePolicies(tx, [{ sourceId: proof.sourceId, permissionVersion: proof.permissionVersion }]);
  for (const capability of ["store_metadata", ...(proof.fulltext ? ["store_fulltext" as const] : [])] as const) {
    const result = await evaluateSourcePolicy(
      {
        source_id: proof.sourceId,
        lane: proof.lane,
        expected_permission_version: proof.permissionVersion,
        capability,
        resource: { url: proof.url, document_type: proof.documentType, attachment: proof.attachment },
      },
      undefined,
      tx,
    );
    if (result.decision !== "allow") throw new CrawlBlocked("crawl_storage_permission_changed");
  }
}
export class CrawlDeferred extends Error {
  readonly retryAt: Date;
  readonly reservationId: string;
  readonly reason: string;
  sessionId?: string;
  constructor(retryAt: Date, reservationId: string, reason: string) {
    super(`crawl_deferred: ${reason}`);
    this.retryAt = retryAt;
    this.reservationId = reservationId;
    this.reason = reason;
  }
}
export class CrawlObsolete extends Error {}
export class CrawlBlocked extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export async function openCrawlSession(scope: string, sourceId: string, binding: string, expectedSessionId?: string) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`crawl-session:${scope}`}))`;
    const [old] = await tx`SELECT id,binding,active FROM acquisition.crawl_sessions WHERE scope=${scope} FOR UPDATE`;
    if (expectedSessionId && (!old?.active || old.id !== expectedSessionId || old.binding !== binding)) throw new CrawlObsolete("crawl_session_obsolete");
    if (old?.active) {
      if (old.binding !== binding) {
        await tx`DELETE FROM acquisition.crawl_requests WHERE session_id=${String(old.id)}`;
        await tx`DELETE FROM acquisition.crawl_checkpoints WHERE session_id=${String(old.id)}`;
        await tx`UPDATE acquisition.crawl_sessions SET binding=${binding},updated_at=now() WHERE id=${String(old.id)}`;
      }
      return String(old.id);
    }
    if (old) await tx`DELETE FROM acquisition.crawl_sessions WHERE id=${String(old.id)}`;
    const id = randomUUID();
    await tx`INSERT INTO acquisition.crawl_sessions(id,scope,source_id,binding) VALUES(${id},${scope},${sourceId},${binding})`;
    return id;
  });
}
export async function finishCrawlSession(id: string) {
  await sql.begin(async (tx) => {
    await tx`UPDATE acquisition.crawl_sessions SET active=false,updated_at=now() WHERE id=${id}`;
    await tx`DELETE FROM acquisition.crawl_requests WHERE session_id=${id}`;
    await tx`DELETE FROM acquisition.crawl_checkpoints WHERE session_id=${id}`;
  });
}
export async function crawlCheckpoint(sessionId: string, name: string) {
  const [row] = await sql`SELECT value FROM acquisition.crawl_checkpoints WHERE session_id=${sessionId} AND name=${name}`;
  return row ? { value: row.value } : null;
}
export async function saveCrawlCheckpoint(sessionId: string, name: string, value: unknown, proof?: CrawlProof) {
  await sql.begin(async (tx) => {
    await lockProof(tx, proof);
    await tx`INSERT INTO acquisition.crawl_checkpoints(session_id,name,value) VALUES(${sessionId},${name},${tx.json(value as never)}) ON CONFLICT DO NOTHING`;
  });
}
export async function robotsObservation(origin: string) {
  const [row] = await sql<
    { status: number; body: string; expires_at: Date; retry_at: Date | null; error: string | null }[]
  >`SELECT status,body,expires_at,retry_at,error FROM acquisition.robots_observations WHERE origin=${origin}`;
  return row ?? null;
}
export async function saveRobots(origin: string, status: number, body: string, now: Date, retryAt: Date | null, error: string | null) {
  const expires = new Date(now.getTime() + (retryAt ? Math.max(1, retryAt.getTime() - now.getTime()) : 86400_000));
  await sql`INSERT INTO acquisition.robots_observations(origin,status,body,observed_at,expires_at,retry_at,error)
    VALUES(${origin},${status},${body},${now},${expires},${retryAt},${error})
    ON CONFLICT(origin) DO UPDATE SET status=EXCLUDED.status,body=EXCLUDED.body,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,retry_at=EXCLUDED.retry_at,error=EXCLUDED.error`;
}
/** Durable FIFO reservation and one actual active request across every lane/source on the same hostname. */
export async function claimCrawlRequest(sessionId: string, key: string, url: string, intervalMs: number, nowInput: Date | undefined, timeoutMs: number) {
  const host = new URL(url).hostname.toLowerCase(),
    id = sha256(`${sessionId}:${key}`);
  const result = await sql.begin(async (tx) => {
    await tx`INSERT INTO acquisition.crawl_hosts(host) VALUES(${host}) ON CONFLICT DO NOTHING`;
    const [h] =
      await tx`SELECT next_slot,last_started,last_finished,cooldown_until,lease_token,lease_until,min_interval_ms FROM acquisition.crawl_hosts WHERE host=${host} FOR UPDATE`;
    const [clock] = await tx<{ now: Date }[]>`SELECT pg_catalog.clock_timestamp() AS now`;
    const now = nowInput ?? clock!.now;
    const [cached] = await tx`SELECT id,ready_at,state,lease_token,fetched_at,status,headers,body,error FROM acquisition.crawl_requests WHERE id=${id}`;
    if (cached?.state === "done" && cached.body !== null) return { cached };
    if (cached?.state === "blocked") return { blocked: String(cached.error) };
    const gap = Math.max(intervalMs, Number(h!.min_interval_ms));
    const ready = cached ? new Date(cached.ready_at) : new Date(Math.max(now.getTime(), new Date(h!.next_slot).getTime()));
    if (!cached) {
      await tx`INSERT INTO acquisition.crawl_requests(id,session_id,host,url,ready_at) VALUES(${id},${sessionId},${host},${url},${ready})`;
      await tx`UPDATE acquisition.crawl_hosts SET next_slot=${new Date(ready.getTime() + gap)},min_interval_ms=${gap} WHERE host=${host}`;
    }
    const wait = Math.max(
      ready.getTime(),
      new Date(h!.cooldown_until).getTime(),
      new Date(h!.last_finished).getTime() + gap,
      h!.lease_token && new Date(h!.lease_until).getTime() > now.getTime()
        ? Math.min(new Date(h!.lease_until).getTime(), now.getTime() + Math.max(gap, 1000))
        : 0,
    );
    if (wait > now.getTime()) return { wait: new Date(wait) };
    const token = randomUUID();
    await tx`UPDATE acquisition.crawl_hosts SET lease_token=${token},lease_until=${new Date(now.getTime() + timeoutMs + 1000)},last_started=${now},min_interval_ms=${intervalMs} WHERE host=${host}`;
    await tx`UPDATE acquisition.crawl_requests SET state='fetching',lease_token=${token},updated_at=now() WHERE id=${id}`;
    return { token };
  });
  if ("blocked" in result) throw new CrawlBlocked(result.blocked!);
  if ("wait" in result) throw new CrawlDeferred(result.wait!, id, "host_pacing");
  return { id, host, ...result };
}
export async function finishCrawlRequest(input: {
  id: string;
  host: string;
  token: string;
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | null;
  blocked?: string;
  retryAt?: Date;
  proof?: CrawlProof;
  now?: Date;
  fetchedAt?: Date;
}) {
  await sql.begin(async (tx) => {
    await lockProof(tx, input.proof);
    const [owned] = await tx`SELECT lease_token FROM acquisition.crawl_hosts WHERE host=${input.host} FOR UPDATE`;
    if (owned?.lease_token !== input.token) throw new CrawlBlocked("crawl_lease_expired");
    const [clock] = await tx<{ now: Date }[]>`SELECT pg_catalog.clock_timestamp() AS now`;
    const finished = input.now ?? clock!.now;
    await tx`UPDATE acquisition.crawl_hosts SET last_finished=${finished},lease_token=NULL,lease_until='1970-01-01T00:00:00Z',cooldown_until=greatest(cooldown_until,${input.retryAt ?? new Date(0)}) WHERE host=${input.host}`;
    await tx`UPDATE acquisition.crawl_requests SET state=${input.blocked ? "blocked" : input.retryAt ? "pending" : "done"},status=${input.status ?? null},
      fetched_at=${input.fetchedAt ?? null},headers=${sql.json(input.headers ?? {})},body=${input.body ?? null},error=${input.blocked ?? null},ready_at=greatest(ready_at,${input.retryAt ?? new Date(0)}),lease_token=NULL,updated_at=now() WHERE id=${input.id} AND lease_token=${input.token}`;
  });
}

export async function crawlClock() {
  const [row] = await sql<{ now: Date }[]>`SELECT pg_catalog.clock_timestamp() AS now`;
  return row!.now;
}
