// Reader preferences and saved references remain in this browser. Never retain article content.
import { useSyncExternalStore } from "react";
import { beijingDate } from "@amp/contracts/time";

export const KEYS = {
  starred: "amp-starred-items",
  theme: "amp-theme",
  feedbackDraft: "amp-feedback-draft-v1",
} as const;

export const STARRED_LIMIT = 100;
const POLICY_KEY = "amp-policy-saved-v1";
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export interface LocalStarredItem {
  type: "item" | "policy" | "story";
  id: string;
  savedAt: string;
}
export type SaveResult = { ok: true; added: boolean } | { ok: false; message: string };
const STORAGE_ERROR = "浏览器暂时无法保存收藏。";

function storage(kind: "local" | "session"): Storage | null {
  try {
    const s = kind === "local" ? window.localStorage : window.sessionStorage;
    return s;
  } catch {
    return null;
  }
}

function readRaw(key: string, kind: "local" | "session" = "local"): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null, kind: "local" | "session" = "local"): boolean {
  try {
    const s = storage(kind);
    if (!s) return false;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// --- change notification (same tab via events, other tabs via the storage event) ---
const listeners = new Map<string, Set<() => void>>();
let subscribers = 0;
function emit(key?: string) {
  for (const [subscribedKey, callbacks] of listeners) {
    if (key === undefined || key === subscribedKey) for (const callback of callbacks) callback();
  }
}
function onStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== storage("local")) return;
  if (event.key === null) cache.clear();
  else cache.delete(event.key);
  // Clear the snapshot once, before notifying all cards. Each key is parsed at most once.
  emit(event.key ?? undefined);
}
function subscribeKey(key: string) {
  return (listener: () => void) => {
    let callbacks = listeners.get(key);
    if (!callbacks) listeners.set(key, (callbacks = new Set()));
    callbacks.add(listener);
    if (subscribers++ === 0) window.addEventListener("storage", onStorage);
    return () => {
      callbacks.delete(listener);
      if (callbacks.size === 0) listeners.delete(key);
      if (--subscribers === 0) window.removeEventListener("storage", onStorage);
    };
  };
}
const subscribeStarred = subscribeKey(KEYS.starred);
const subscribeTheme = subscribeKey(KEYS.theme);

// Snapshot cache so useSyncExternalStore gets stable references between changes.
const cache = new Map<string, unknown>();
function cached<T>(key: string, compute: () => T): T {
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key) as T;
}
function invalidate(key: string) {
  cache.delete(key);
  emit(key);
}

// --- starred ---
function normalizeStarred(value: unknown): LocalStarredItem | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID_PATTERN.test(v.id)) return null;
  let savedAt = new Date().toISOString();
  if (typeof v.savedAt === "string") {
    try {
      beijingDate(v.savedAt);
      savedAt = v.savedAt;
    } catch {
      /* Keep the reference with a usable added time. */
    }
  }
  return { type: v.type === "policy" || v.type === "story" ? v.type : "item", id: v.id, savedAt };
}

export function getStarred(): LocalStarredItem[] {
  return cached(KEYS.starred, () => {
    const raw = readRaw(KEYS.starred);
    let refs: LocalStarredItem[] = [];
    try {
      const parsed: unknown = JSON.parse(raw ?? "[]");
      if (Array.isArray(parsed))
        refs = parsed.flatMap((v) => {
          const ref = normalizeStarred(v);
          return ref ? [ref] : [];
        });
    } catch {
      /* Corrupt entries cannot become content. */
    }
    // Migrate only this new site's former policy references, never the retired site's keys.
    try {
      const policies: unknown = JSON.parse(readRaw(POLICY_KEY) ?? "[]");
      if (Array.isArray(policies))
        for (const id of policies) {
          if (typeof id === "string" && ID_PATTERN.test(id)) refs.push({ type: "policy", id, savedAt: new Date().toISOString() });
        }
    } catch {
      /* Ignore corrupt legacy references. */
    }
    const seen = new Set<string>();
    refs = refs.filter((ref) => {
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Remove old title/summary copies. Existing references above the new limit remain removable.
    if ((raw || refs.length) && writeRaw(KEYS.starred, JSON.stringify(refs))) writeRaw(POLICY_KEY, null);
    return refs;
  });
}

export function isStarred(id: string, type: LocalStarredItem["type"] = "item"): boolean {
  return getStarred().some((ref) => ref.type === type && ref.id === id);
}

export function toggleStar(item: { id: string; type?: LocalStarredItem["type"] }): SaveResult {
  const list = getStarred(),
    type = item.type ?? "item";
  const exists = list.some((s) => s.id === item.id && s.type === type);
  if (!exists && list.length >= STARRED_LIMIT) return { ok: false, message: "最多收藏100条，请先移除一些收藏。" };
  const next = exists ? list.filter((s) => s.id !== item.id || s.type !== type) : [{ type, id: item.id, savedAt: new Date().toISOString() }, ...list];
  if (!writeRaw(KEYS.starred, JSON.stringify(next))) return { ok: false, message: STORAGE_ERROR };
  invalidate(KEYS.starred);
  return { ok: true, added: !exists };
}

export function removeStar(id: string, type: LocalStarredItem["type"] = "item"): SaveResult {
  if (!writeRaw(KEYS.starred, JSON.stringify(getStarred().filter((s) => s.id !== id || s.type !== type)))) return { ok: false, message: STORAGE_ERROR };
  invalidate(KEYS.starred);
  return { ok: true, added: false };
}

// --- theme ---
export type ThemePreference = "light" | "dark" | null;

export function getThemePreference(): ThemePreference {
  const v = readRaw(KEYS.theme);
  if (v === "light" || v === "dark") return v;
  // Tolerate a JSON-quoted value written by other code paths.
  if (v === '"light"' || v === '"dark"') return JSON.parse(v);
  return null;
}

export function setThemePreference(pref: ThemePreference) {
  writeRaw(KEYS.theme, pref);
  invalidate(KEYS.theme);
}

export function resolvedTheme(pref: ThemePreference = getThemePreference()): "light" | "dark" {
  if (pref) return pref;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Inline script run before paint so the first frame already has the reader's theme. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEYS.theme}');if(t==='"light"'||t==='"dark"')t=JSON.parse(t);if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;

// --- React hooks ---
const EMPTY_STARRED: LocalStarredItem[] = [];

export function useStarred(): LocalStarredItem[] {
  return useSyncExternalStore(subscribeStarred, getStarred, () => EMPTY_STARRED);
}

export function useIsStarred(id: string, type: LocalStarredItem["type"] = "item"): boolean {
  return useSyncExternalStore(
    subscribeStarred,
    () => isStarred(id, type),
    () => false,
  );
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, getThemePreference, () => null);
}
