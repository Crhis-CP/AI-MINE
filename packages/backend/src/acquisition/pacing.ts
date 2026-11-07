import { randomUUID } from "node:crypto";
import { evaluateSourcePolicy, lockCurrentSourcePolicies } from "@amp/backend/admin/sources";
import { sql, type Tx } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

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
  /** Concrete cause behind the reason (timeout, dns_temporary, robots_http_503 ...); stored on the run. */
  readonly causeCode?: string;
  sessionId?: string;
  constructor(retryAt: Date, reservationId: string, reason: string, causeCode?: string) {
    super(`crawl_deferred: ${reason}`);
    this.retryAt = retryAt;
    this.reservationId = reservationId;
    this.reason = reason;
    if (causeCode) this.causeCode = causeCode;
  }
}
/** A transport failure that waiting will not heal (no such domain, invalid certificate, blocked address).
 * It fails the run so the source's fail count and backoff apply, instead of deferring forever. */
export class CrawlTransportFailed extends Error {
  readonly transportCause: string;
  constructor(transportCause: string, host: string) {
    super(`transport_${transportCause}: ${host}`);
    this.transportCause = transportCause;
  }
}
export class CrawlObsolete extends Error {}
export class CrawlBlocked extends Error {
  readonly code: string;
  /** Optional operator hint, e.g. the new address of a redirect that left the configured host. */
  readonly detail?: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    if (detail) this.detail = detail;
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
  // jsonb NOT NULL rejects SQL NULL. postgres.js sends SQL NULL for null/undefined, so a step with nothing to resume must not insert a row.
  if (value === null || value === undefined) return;
  await sql.begin(async (tx) => {
    await lockProof(tx, proof);
    await tx`INSERT INTO acquisition.crawl_checkpoints(session_id,name,value) VALUES(${sessionId},${name},${tx.json(value as never)}) ON CONFLICT DO NOTHING`;
  });
}
export type RobotsObservation = {
  /** Status of the last good observation; 0 when no good copy was ever read. */
  status: number;
  body: string;
  observed_at: Date;
  expires_at: Date;
  retry_at: Date | null;
  /** robots_unavailable while the current read is failing; any other code blocks the origin (challenge ...). */
  error: string | null;
  final_url: string | null;
  warning: string | null;
  failure_since: Date | null;
  failure_count: number;
  failure_reason: string | null;
};
export async function robotsObservation(origin: string) {
  const [row] = await sql<RobotsObservation[]>`
    SELECT status,body,observed_at,expires_at,retry_at,error,final_url,warning,failure_since,failure_count,failure_reason
    FROM acquisition.robots_observations WHERE origin=${origin}`;
  return row ?? null;
}
/** A completed robots read: a good copy, or an RFC 9309 "unavailable" 4xx (allow all). Ends any failure streak. */
export async function saveRobots(
  origin: string,
  status: number,
  body: string,
  now: Date,
  retryAt: Date | null,
  error: string | null,
  extra: { finalUrl?: string | null; warning?: string | null } = {},
) {
  const expires = new Date(now.getTime() + (retryAt ? Math.max(1, retryAt.getTime() - now.getTime()) : 86400_000));
  await sql`INSERT INTO acquisition.robots_observations(origin,status,body,observed_at,expires_at,retry_at,error,final_url,warning,failure_since,failure_count,failure_reason)
    VALUES(${origin},${status},${body},${now},${expires},${retryAt},${error},${extra.finalUrl ?? null},${extra.warning ?? null},NULL,0,NULL)
    ON CONFLICT(origin) DO UPDATE SET status=EXCLUDED.status,body=EXCLUDED.body,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,
      retry_at=EXCLUDED.retry_at,error=EXCLUDED.error,final_url=EXCLUDED.final_url,warning=EXCLUDED.warning,failure_since=NULL,failure_count=0,failure_reason=NULL`;
}
/** A blocking code (challenge page ...) holds the origin for a day. The last good copy stays stored but is not used. */
export async function saveRobotsBlocked(origin: string, now: Date, code: string) {
  const expires = new Date(now.getTime() + 86400_000);
  await sql`INSERT INTO acquisition.robots_observations(origin,status,body,observed_at,expires_at,retry_at,error)
    VALUES(${origin},0,'',${now},${expires},NULL,${code})
    ON CONFLICT(origin) DO UPDATE SET expires_at=EXCLUDED.expires_at,retry_at=NULL,error=EXCLUDED.error`;
}
/** Waits after consecutive robots read failures: 5 min, 15 min, 1 h, then every 6 h. */
export const ROBOTS_FAILURE_BACKOFF_MS = [300_000, 900_000, 3_600_000, 21_600_000] as const;
/**
 * A robots read that failed (5xx, 429, network). The failure is stored beside the last good copy, never over it
 * (RFC 9309 §2.3.1.4): status/body/observed_at keep the good copy, failure_* describe the current streak.
 */
export async function saveRobotsFailure(origin: string, now: Date, reason: string, notBefore?: Date) {
  return sql.begin(async (tx) => {
    const [old] = await tx<{ error: string | null; failure_count: number }[]>`
      SELECT error,failure_count FROM acquisition.robots_observations WHERE origin=${origin} FOR UPDATE`;
    const count = (old?.error === "robots_unavailable" ? Number(old.failure_count) : 0) + 1,
      wait = ROBOTS_FAILURE_BACKOFF_MS[Math.min(count, ROBOTS_FAILURE_BACKOFF_MS.length) - 1]!,
      retryAt = new Date(Math.max(now.getTime() + wait, notBefore?.getTime() ?? 0));
    await tx`INSERT INTO acquisition.robots_observations(origin,status,body,observed_at,expires_at,retry_at,error,failure_since,failure_count,failure_reason)
      VALUES(${origin},0,'',${now},${retryAt},${retryAt},'robots_unavailable',${now},${count},${reason})
      ON CONFLICT(origin) DO UPDATE SET expires_at=EXCLUDED.expires_at,retry_at=EXCLUDED.retry_at,error='robots_unavailable',
        failure_since=CASE WHEN robots_observations.error='robots_unavailable'
          THEN coalesce(robots_observations.failure_since,EXCLUDED.failure_since) ELSE EXCLUDED.failure_since END,
        failure_count=EXCLUDED.failure_count,failure_reason=EXCLUDED.failure_reason`;
    return { retryAt, count };
  });
}
/** Durable FIFO reservation and one actual active request across every lane/source on the same hostname. */
export async function claimCrawlRequest(
  sessionId: string,
  key: string,
  url: string,
  intervalMs: number,
  nowInput: Date | undefined,
  timeoutMs: number,
  cacheValidAfter?: Date,
) {
  const host = new URL(url).hostname.toLowerCase(),
    id = sha256(`${sessionId}:${key}`);
  const result = await sql.begin(async (tx) => {
    await tx`INSERT INTO acquisition.crawl_hosts(host) VALUES(${host}) ON CONFLICT DO NOTHING`;
    const [h] =
      await tx`SELECT next_slot,last_started,last_finished,cooldown_until,lease_token,lease_until,min_interval_ms FROM acquisition.crawl_hosts WHERE host=${host} FOR UPDATE`;
    const [clock] = await tx<{ now: Date }[]>`SELECT pg_catalog.clock_timestamp() AS now`;
    const now = nowInput ?? clock!.now;
    const [cached] = await tx`SELECT id,ready_at,state,lease_token,fetched_at,status,headers,body,error FROM acquisition.crawl_requests WHERE id=${id}`;
    if (cached?.state === "done" && cached.body !== null && (!cacheValidAfter || (cached.fetched_at && new Date(cached.fetched_at) >= cacheValidAfter)))
      return { cached };
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
  /** Reader failures wait on this request only. Cooling the host would hold every other page. */
  coolHost?: boolean;
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
    const coolHost = input.coolHost !== false;
    await tx`UPDATE acquisition.crawl_hosts SET last_finished=${finished},lease_token=NULL,lease_until='1970-01-01T00:00:00Z',cooldown_until=CASE WHEN ${coolHost} THEN greatest(cooldown_until,${input.retryAt ?? new Date(0)}) ELSE cooldown_until END WHERE host=${input.host}`;
    await tx`UPDATE acquisition.crawl_requests SET state=${input.blocked ? "blocked" : input.retryAt ? "pending" : "done"},status=${input.status ?? null},
      fetched_at=${input.fetchedAt ?? null},headers=${sql.json(input.headers ?? {})},body=${input.body ?? null},error=${input.blocked ?? null},ready_at=greatest(ready_at,${input.retryAt ?? new Date(0)}),lease_token=NULL,updated_at=now() WHERE id=${input.id} AND lease_token=${input.token}`;
    // Any HTTP response ends the host's run of transport failures.
    if (input.status !== undefined)
      await tx`UPDATE acquisition.crawl_hosts SET transport_failures=0,transport_cause=NULL WHERE host=${input.host} AND transport_failures>0`;
  });
}
/** Count one more consecutive transport failure on a host; the caller derives its backoff from the count. */
export async function recordHostTransportFailure(host: string, cause: string) {
  const [row] = await sql<{ transport_failures: number }[]>`UPDATE acquisition.crawl_hosts
    SET transport_failures=transport_failures+1,transport_cause=${cause} WHERE host=${host} RETURNING transport_failures`;
  return Number(row?.transport_failures ?? 1);
}

export async function crawlClock() {
  const [row] = await sql<{ now: Date }[]>`SELECT pg_catalog.clock_timestamp() AS now`;
  return row!.now;
}
