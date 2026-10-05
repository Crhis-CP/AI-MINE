import { setTimeout as delay } from "node:timers/promises";

const REASONS = ["endpoint_lookup", "invalid_endpoint", "connection", "redirect", "http_status", "invalid_response", "cancelled", "operation_failed"] as const;
export type HealthObservation = { target: string; status: number; direct: boolean };
export type HealthFailure = { reason: (typeof REASONS)[number]; observation: HealthObservation | null };

const targetUrl = (address: string) => {
  try {
    const url = new URL(address);
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/api/health" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
};

export class LocalHealthFailure extends Error {
  readonly failure: HealthFailure;
  constructor(reason: HealthFailure["reason"], observation: HealthObservation | null = null) {
    super(`Local health failed: ${reason}`);
    this.failure = { reason, observation };
  }
}

/** Bounded machine evidence only; never pass through an HTTP body, Location, environment or command error. */
export function healthFailureEvidence(value: unknown): HealthFailure | null {
  if (!value || typeof value !== "object") return null;
  const failure = value as Record<string, unknown>;
  if (!(REASONS as readonly unknown[]).includes(failure.reason)) return null;
  const response = failure.observation;
  if (response === null) return { reason: failure.reason as HealthFailure["reason"], observation: null };
  if (!response || typeof response !== "object") return null;
  const observation = response as Record<string, unknown>;
  if (
    typeof observation.target !== "string" ||
    targetUrl(observation.target) !== observation.target ||
    typeof observation.status !== "number" ||
    !Number.isInteger(observation.status) ||
    observation.status < 100 ||
    observation.status > 599 ||
    typeof observation.direct !== "boolean"
  )
    return null;
  return {
    reason: failure.reason as HealthFailure["reason"],
    observation: { target: observation.target, status: observation.status, direct: observation.direct },
  };
}

/** Resolve the registered local endpoint before HTTP; a command/connection failure is not an observed HTTP failure. */
export async function readLocalHealth(
  resolveAddress: () => Promise<string>,
  release: string,
  options: { signal?: AbortSignal; attempts?: number; intervalMs?: number } = {},
) {
  let address: string;
  try {
    address = await resolveAddress();
  } catch {
    throw new LocalHealthFailure("endpoint_lookup");
  }
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new LocalHealthFailure("invalid_endpoint");
  const target = targetUrl(`http://${address}/api/health`);
  if (!target) throw new LocalHealthFailure("invalid_endpoint");
  let last = new LocalHealthFailure("connection");
  const attempts = options.attempts ?? 60;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) throw new LocalHealthFailure("cancelled");
    let response: Response;
    try {
      response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(1000) });
    } catch {
      last = new LocalHealthFailure("connection");
      await delay(options.intervalMs ?? 500);
      continue;
    }
    const observation = { target, status: response.status, direct: response.url === target && !response.redirected };
    if (!observation.direct || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new LocalHealthFailure("redirect", observation);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      last = new LocalHealthFailure("http_status", observation);
    } else {
      try {
        const body = await response.json();
        if (
          body !== null &&
          typeof body === "object" &&
          "ok" in body &&
          body.ok === true &&
          "db" in body &&
          body.db === "ok" &&
          "release" in body &&
          body.release === release
        )
          return observation;
      } catch {
        /* An invalid or interrupted body cannot establish health. */
      }
      last = new LocalHealthFailure("invalid_response", observation);
    }
    if (attempt + 1 < attempts) await delay(options.intervalMs ?? 500);
  }
  throw last;
}
