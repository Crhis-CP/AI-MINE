// Which reader pages the public host serves (DEC-79): the old ones compiled from app/, or the rewrite in reader/.
// One process setting, READER_IMPL, read once when the web process starts; server.ts imports only the chosen build.
// No imports, so the server, the tests and the checks read the same few lines.

export type ReaderImpl = "old" | "new";

/**
 * What the public host serves when READER_IMPL is unset. Changing this line is the reader cutover (plan 3.10);
 * apps/web/tests/reader-routes.test.ts refuses "new" until the rewrite has every page the release and smoke checks open.
 */
export const DEFAULT_READER_IMPL: ReaderImpl = "old";

/** The build directory under apps/web/build of each implementation. */
export const READER_BUILD = { old: "public", new: "reader" } as const satisfies Record<ReaderImpl, string>;

/**
 * READER_IMPL as set. Unset or empty means the default: docker-compose passes an unset variable as an empty string.
 * Null when the value cannot be read; server.ts then says so in its start log and serves the default.
 */
export function readerImplSetting(env: Readonly<Record<string, string | undefined>> = process.env): ReaderImpl | null {
  const raw = env.READER_IMPL?.trim();
  if (!raw) return DEFAULT_READER_IMPL;
  return raw === "old" || raw === "new" ? raw : null;
}
