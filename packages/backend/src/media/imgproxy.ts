// Signed image proxy URLs: /api/img-proxy?u=&mode=&exp=&sig=. Off for public pages and feeds, which
// link to a picture on the source's site instead (DR-78); kept for sources the Owner authorises.
// sig = hex(HMAC-SHA256(IMG_PROXY_SIGN_SECRET, `${u}|${mode}|${exp}`)), sent as its first 16 hex
// digits (64 bits): the random digits cannot be compressed, and the full 64 made up about a tenth
// of a compressed list page. A full-length signature from an older URL is still accepted.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, credential } from "../config.ts";

import { IMAGE_WIDTHS, RESPONSIVE_MODES, type ProxyMode, type ResponsiveImageKind } from "./renditions.ts";
export type { ProxyMode } from "./renditions.ts";

// A URL keeps its expiry for a whole day, so the edge and browsers can reuse one copy of an image all
// day; it stays valid for two to three days.
const WINDOW_SECONDS = 24 * 3600;
const LIFETIME_SECONDS = 48 * 3600;
const SIG_HEX = 16;

function secret(): string {
  const s = credential("auth", "IMG_PROXY_SIGN_SECRET");
  if (!s) throw new Error("IMG_PROXY_SIGN_SECRET is not configured");
  return s;
}

export function signature(url: string, mode: string, exp: number | string): string {
  return createHmac("sha256", secret()).update(`${url}|${mode}|${exp}`).digest("hex");
}

/** Expiry rounded up to a day boundary at least `lifetime` (48 h) ahead, so URLs stay cacheable. */
export function proxyExpiry(nowMs = Date.now(), lifetimeSeconds = LIFETIME_SECONDS): number {
  return Math.ceil((nowMs / 1000 + lifetimeSeconds) / WINDOW_SECONDS) * WINDOW_SECONDS;
}

export function proxiedImage(
  url: string | null | undefined,
  mode: ProxyMode,
  absolute = false,
  nowMs = Date.now(),
  lifetimeSeconds = LIFETIME_SECONDS,
): string | null {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  const exp = proxyExpiry(nowMs, lifetimeSeconds);
  const path = `/api/img-proxy?u=${encodeURIComponent(url)}&mode=${mode}&exp=${exp}&sig=${signature(url, mode, exp).slice(0, SIG_HEX)}`;
  return absolute ? `${config.siteUrl}${path}` : path;
}

/** Browser source candidates, each independently signed with the same expiry boundary. */
export function proxiedImageSet(
  url: string | null | undefined,
  kind: ResponsiveImageKind,
  absolute = false,
  nowMs = Date.now(),
  lifetimeSeconds = LIFETIME_SECONDS,
): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return RESPONSIVE_MODES[kind].map((mode) => `${proxiedImage(url, mode, absolute, nowMs, lifetimeSeconds)} ${IMAGE_WIDTHS[mode]}w`).join(", ");
}

export type VerifyResult = { ok: true; url: string; mode: string } | { ok: false; reason: "missing" | "expired" | "bad-signature" | "bad-url" };

export function verifyProxyRequest(params: { u?: string; mode?: string; exp?: string; sig?: string }, nowMs = Date.now()): VerifyResult {
  const { u, mode, exp, sig } = params;
  if (!u || mode === "" || !exp || !sig) return { ok: false, reason: "missing" };
  if (!/^\d{9,11}$/.test(exp)) return { ok: false, reason: "missing" };
  if (Number(exp) * 1000 < nowMs) return { ok: false, reason: "expired" };
  if (!/^https?:\/\//i.test(u)) return { ok: false, reason: "bad-url" };
  // Legacy article pages signed body images without a mode (as "default"); those still in open tabs and
  // caches keep loading, as full images, until their signature expires.
  const given = Buffer.from(new RegExp(`^(?:[0-9a-f]{${SIG_HEX}}|[0-9a-f]{64})$`, "i").test(sig) ? sig : "", "hex");
  const expected = Buffer.from(signature(u, mode ?? "default", exp), "hex").subarray(0, given.length);
  if (given.length === 0 || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad-signature" };
  return { ok: true, url: u, mode: mode ?? "full" };
}
