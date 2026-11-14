// The shared-cache rule for public reader pages (TASK-0672, DEC-78补充·公开页面缓存 30 秒) and the per-request record
// of a loader that had to show less than it should (TASK-0679 R13). Route headers and loaders only declare; server.ts
// decides the final Cache-Control. This file is loaded twice, by server.ts and inside the server build, so the request
// record lives under one process-wide key.
import { AsyncLocalStorage } from "node:async_hooks";

/** Owner 2026-11-14: “页面缓存可以开。” A shared cache may keep a reader page's HTML this long. */
export const DEFAULT_PAGE_CACHE_SECONDS = 30;
/** The setting's upper bound: a longer cache would keep a withdrawn page in front of new readers for minutes. */
export const MAX_PAGE_CACHE_SECONDS = 300;
/** A route's headers carry this mark when its HTML may be shared; server.ts removes it before the response leaves. */
export const READER_PAGE_MARK = "X-Amp-Reader-Page";

/** PAGE_CACHE_SECONDS: whole seconds from 0 (off) to 300; unset means 30. Null when the value cannot be read. */
export function pageCacheSetting(env: Readonly<Record<string, string | undefined>> = process.env): number | null {
  const raw = env.PAGE_CACHE_SECONDS?.trim();
  if (!raw) return DEFAULT_PAGE_CACHE_SECONDS;
  return /^\d{1,3}$/.test(raw) && Number(raw) <= MAX_PAGE_CACHE_SECONDS ? Number(raw) : null;
}

/** The seconds in force; a value that cannot be read keeps the default (server.ts says so once at start). */
export function pageCacheSeconds(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return pageCacheSetting(env) ?? DEFAULT_PAGE_CACHE_SECONDS;
}

export type PageState = { degraded: boolean };
const STORE = Symbol.for("amp.web.page-state");
const holder = globalThis as typeof globalThis & { [STORE]?: AsyncLocalStorage<PageState> };
holder[STORE] ??= new AsyncLocalStorage<PageState>();
const store = holder[STORE];

/** Runs one request's rendering with its own record (server.ts). */
export function withPageState<T>(state: PageState, render: () => T): T {
  return store.run(state, render);
}

/**
 * A loader that fell back after a failed read (the footer without its filing numbers, a list without its counts)
 * keeps this whole response out of every cache: the next reader asks again instead of getting the gap for 30 seconds.
 */
export function markDegraded(): void {
  const state = store.getStore();
  if (state) state.degraded = true;
}
