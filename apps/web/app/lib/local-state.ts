// Reader preferences and saved references remain in this browser. Never retain article content.
import { useEffect, useSyncExternalStore } from "react";
import { beijingDate } from "@amp/contracts/time";

export const KEYS = {
  starred: "amp-starred-items",
  read: "amp-read-items",
  recentSearches: "amp-recent-searches",
  theme: "amp-theme",
  font: "amp-font",
  changelogSeen: "amp-changelog-seen-version",
  feedbackDraft: "amp-feedback-draft-v1",
} as const;

export const STARRED_LIMIT = 500;
export const READ_LIMIT = 5000;
export const IMPORT_MAX_CHARS = 2_000_000;
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
  if (event.key === null || event.key === KEYS.font) unsavedFont = undefined;
  if (event.key === null || event.key === KEYS.changelogSeen) unsavedChangelogSeen = undefined;
  if (event.key === null) cache.clear();
  else {
    cache.delete(event.key);
    if (event.key === KEYS.read) cache.delete(KEYS.read + ":set");
  }
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
const subscribeFont = subscribeKey(KEYS.font);
const subscribeChangelog = subscribeKey(KEYS.changelogSeen);
const subscribeRead = subscribeKey(KEYS.read);
const subscribeRecentSearches = subscribeKey(KEYS.recentSearches);

// Snapshot cache so useSyncExternalStore gets stable references between changes.
const cache = new Map<string, unknown>();
function cached<T>(key: string, compute: () => T): T {
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key) as T;
}
function invalidate(key: string) {
  if (key === KEYS.read) cache.delete(KEYS.read + ":set");
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

function unreadableList(key: string): boolean {
  const raw = readRaw(key);
  if (!raw) return false;
  try {
    return !Array.isArray(JSON.parse(raw));
  } catch {
    return true;
  }
}

export function getStarred(): LocalStarredItem[] {
  return cached(KEYS.starred, () => {
    if (unreadableList(KEYS.starred)) return [];
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
  if (!ID_PATTERN.test(item.id)) return { ok: false, message: "这条收藏的地址无效。" };
  if (unreadableList(KEYS.starred)) return { ok: false, message: "已有收藏数据无法读取，暂不覆盖。" };
  const list = getStarred(),
    type = item.type ?? "item";
  const exists = list.some((s) => s.id === item.id && s.type === type);
  if (!exists && list.length >= STARRED_LIMIT) return { ok: false, message: `最多收藏${STARRED_LIMIT}条，请先移除一些收藏。` };
  const next = exists ? list.filter((s) => s.id !== item.id || s.type !== type) : [{ type, id: item.id, savedAt: new Date().toISOString() }, ...list];
  if (!writeRaw(KEYS.starred, JSON.stringify(next))) return { ok: false, message: STORAGE_ERROR };
  invalidate(KEYS.starred);
  return { ok: true, added: !exists };
}

export function removeStar(id: string, type: LocalStarredItem["type"] = "item"): SaveResult {
  if (unreadableList(KEYS.starred)) return { ok: false, message: "已有收藏数据无法读取，暂不覆盖。" };
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

export type FontPreference = "browser" | null;
let unsavedFont: FontPreference | undefined;
export function getFontPreference(): FontPreference {
  return unsavedFont !== undefined ? unsavedFont : readRaw(KEYS.font) === "browser" ? "browser" : null;
}
export function setFontPreference(pref: FontPreference): boolean {
  const saved = writeRaw(KEYS.font, pref);
  unsavedFont = saved ? undefined : pref;
  emit(KEYS.font);
  return saved;
}
export function useFontPreference(): FontPreference {
  return useSyncExternalStore(subscribeFont, getFontPreference, () => null);
}
const THEME_COLOR = { light: "#faf9f6", dark: "#13191c" } as const;
export function applyTheme(theme: "light" | "dark", followsSystem: boolean) {
  document.documentElement.setAttribute("data-theme", theme);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    meta.content = followsSystem ? THEME_COLOR[meta.media.includes("dark") ? "dark" : "light"] : THEME_COLOR[theme];
}
export function useAppearanceSync() {
  const font = useFontPreference(),
    theme = useThemePreference();
  useEffect(() => {
    document.documentElement.setAttribute("data-font", font ?? getFontPreference() ?? "system");
  }, [font]);
  useEffect(() => {
    const current = theme ?? getThemePreference();
    applyTheme(resolvedTheme(current), current === null);
    if (current !== null) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = () => applyTheme(media.matches ? "dark" : "light", true);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, [theme]);
}

/** Drawings update after the page has applied its actual theme or font. */
export function watchAppearance(onChange: (change: "theme" | "font") => void): () => void {
  const observer = new MutationObserver((records) => {
    for (const change of new Set(records.map((r) => (r.attributeName === "data-font" ? "font" : "theme")))) onChange(change);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font"] });
  return () => observer.disconnect();
}

/** Set local appearance before the first paint, including legacy quoted theme values. */
export const THEME_BOOT_SCRIPT = `(function(){var f='system';try{f=localStorage.getItem('${KEYS.font}')==='browser'?'browser':'system'}catch(e){}document.documentElement.setAttribute('data-font',f);try{var t=localStorage.getItem('${KEYS.theme}');if(t==='"light"'||t==='"dark"')t=JSON.parse(t);if(t==='light'||t==='dark'){document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.content=t==='dark'?'${THEME_COLOR.dark}':'${THEME_COLOR.light}'})}else{t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;

const CHANGELOG_VERSION = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/;
let unsavedChangelogSeen: string | undefined;
export function getChangelogSeen(): string | null {
  const value = unsavedChangelogSeen ?? readRaw(KEYS.changelogSeen);
  return value && CHANGELOG_VERSION.test(value) ? value : null;
}
export function setChangelogSeen(version: string): void {
  if (!CHANGELOG_VERSION.test(version) || version <= (getChangelogSeen() ?? "")) return;
  unsavedChangelogSeen = writeRaw(KEYS.changelogSeen, version) ? undefined : version;
  emit(KEYS.changelogSeen);
}
export function useChangelogUnread(version: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribeChangelog,
    () => !!version && CHANGELOG_VERSION.test(version) && version > (getChangelogSeen() ?? ""),
    () => false,
  );
}

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

// Read marks retain IDs only, newest first. Removing a mark never affects public content.
export function getReadIds(): string[] {
  return cached(KEYS.read, () => {
    try {
      const value: unknown = JSON.parse(readRaw(KEYS.read) ?? "[]");
      return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && ID_PATTERN.test(id)))].slice(0, READ_LIMIT) : [];
    } catch {
      return [];
    }
  });
}
export function markRead(id: string): boolean {
  if (!ID_PATTERN.test(id) || unreadableList(KEYS.read)) return false;
  const ids = getReadIds();
  if (ids[0] === id) return true;
  if (!writeRaw(KEYS.read, JSON.stringify([id, ...ids.filter((v) => v !== id)].slice(0, READ_LIMIT)))) return false;
  invalidate(KEYS.read);
  return true;
}
const EMPTY_READ_SET: ReadonlySet<string> = new Set();
export function useReadSet(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeRead,
    () => cached<Set<string>>(KEYS.read + ":set", () => new Set(getReadIds())),
    () => EMPTY_READ_SET,
  );
}
export function useIsRead(id: string): boolean {
  return useSyncExternalStore(
    subscribeRead,
    () => cached<Set<string>>(KEYS.read + ":set", () => new Set(getReadIds())).has(id),
    () => false,
  );
}

export interface ExportBundle {
  version: 1;
  starred: LocalStarredItem[];
  read: string[];
  theme: "light" | "dark" | "auto";
  font?: "system" | "browser";
}
export function exportBundle(): ExportBundle {
  if (unreadableList(KEYS.starred)) throw new Error("已有收藏数据无法读取，暂不能导出。");
  return { version: 1, starred: getStarred(), read: getReadIds(), theme: getThemePreference() ?? "auto", font: getFontPreference() ?? "system" };
}
export interface ImportReport {
  starredAdded: number;
  starredSkipped: number;
  readAdded: number;
  readSkipped: number;
  readFailed: boolean;
  themeApplied: boolean;
  fontApplied: boolean;
}
/** Merge references only; existing choices and unavailable content cannot be restored by imported copy. */
export function importBundle(text: string): ImportReport {
  if (text.length > IMPORT_MAX_CHARS) throw new Error("文件过大（上限 2,000,000 字符）");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("不是有效的 JSON 文件");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("文件格式不对（需要 version: 1）");
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || !Array.isArray(data.starred) || !Array.isArray(data.read)) throw new Error("文件格式不对（需要 version: 1 的收藏与已读记录）");
  if (unreadableList(KEYS.starred)) throw new Error("已有收藏数据无法读取，为避免覆盖，这次没有导入。");
  const current = getStarred();
  const seen = new Set(current.map((ref) => `${ref.type}:${ref.id}`));
  const additions: LocalStarredItem[] = [];
  let starredSkipped = 0;
  for (const entry of data.starred) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const ref = normalizeStarred(record);
    if (
      !ref ||
      !record ||
      (record.type !== undefined && !["item", "policy", "story"].includes(String(record.type))) ||
      typeof record.savedAt !== "string" ||
      !Number.isFinite(Date.parse(record.savedAt))
    ) {
      starredSkipped++;
      continue;
    }
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (current.length + additions.length >= STARRED_LIMIT) {
      starredSkipped++;
      continue;
    }
    additions.push(ref);
  }
  const merged = [...current, ...additions].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
  if (!writeRaw(KEYS.starred, JSON.stringify(merged))) throw new Error("浏览器存储已满或不可用，这次没有导入任何内容。");
  const reads = getReadIds(),
    readSeen = new Set(reads),
    readAdditions: string[] = [];
  let readSkipped = 0;
  for (const id of data.read) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      readSkipped++;
      continue;
    }
    if (readSeen.has(id)) continue;
    readSeen.add(id);
    if (reads.length + readAdditions.length >= READ_LIMIT) {
      readSkipped++;
      continue;
    }
    readAdditions.push(id);
  }
  const readFailed = unreadableList(KEYS.read) || !writeRaw(KEYS.read, JSON.stringify([...reads, ...readAdditions]));
  const themeApplied = !getThemePreference() && (data.theme === "light" || data.theme === "dark") && writeRaw(KEYS.theme, data.theme);
  const fontApplied = !getFontPreference() && data.font === "browser" && writeRaw(KEYS.font, "browser");
  cache.clear();
  emit();
  return {
    fontApplied,
    starredAdded: additions.length,
    starredSkipped,
    readAdded: readFailed ? 0 : readAdditions.length,
    readSkipped,
    readFailed,
    themeApplied,
  };
}

const EMPTY_SEARCHES: string[] = [];
export function getRecentSearches(): string[] {
  return cached(KEYS.recentSearches, () => {
    try {
      const values: unknown = JSON.parse(readRaw(KEYS.recentSearches) ?? "[]");
      if (!Array.isArray(values)) return [];
      const seen = new Set<string>();
      return values
        .flatMap((value) => {
          if (typeof value !== "string") return [];
          const query = value.trim().slice(0, 200),
            identity = query.toLowerCase();
          if (!query || seen.has(identity)) return [];
          seen.add(identity);
          return [query];
        })
        .slice(0, 10);
    } catch {
      return [];
    }
  });
}
export function addRecentSearch(value: string): boolean {
  const query = value.trim().slice(0, 200);
  if (!query) return false;
  const rest = getRecentSearches().filter((old) => old.toLowerCase() !== query.toLowerCase());
  if (!writeRaw(KEYS.recentSearches, JSON.stringify([query, ...rest].slice(0, 10)))) return false;
  invalidate(KEYS.recentSearches);
  return true;
}
export function clearRecentSearches(): boolean {
  if (!writeRaw(KEYS.recentSearches, null)) return false;
  invalidate(KEYS.recentSearches);
  return true;
}
export function useRecentSearches(): string[] {
  return useSyncExternalStore(subscribeRecentSearches, getRecentSearches, () => EMPTY_SEARCHES);
}
