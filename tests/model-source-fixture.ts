import { readCurrentSourcePolicy } from "@amp/backend/admin/sources";
import { grantDateFixture } from "./source-date-fixture.ts";

const sourceInitializations = new Map<string, Promise<void>>();

/** Explicit source permission for local provider stubs; never relax an existing deny/unknown policy. */
export async function ensureModelSourceFixture(sourceId: string, urls: string[]) {
  if (!/_(test|ci)$/.test(new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname))
    throw new Error("Synthetic source permission requires an isolated test database");
  const pending = sourceInitializations.get(sourceId);
  if (pending) return pending;
  const work = (async () => {
    if (!(await readCurrentSourcePolicy(sourceId))) await grantDateFixture(sourceId, urls);
  })();
  sourceInitializations.set(sourceId, work);
  try {
    await work;
  } finally {
    if (sourceInitializations.get(sourceId) === work) sourceInitializations.delete(sourceId);
  }
}

/** A deliberately direct gateway test still authorizes its registered synthetic material. */
export async function materialFixturePermit(articleId: string, request: { system: string; user: unknown }) {
  const { readCurrentBody } = await import("@amp/backend/content/materials");
  const { prepareNewsFallback } = await import("../packages/backend/src/providers/news-fallback.ts");
  const { shutdownSignal } = await import("@amp/backend/jobs/queue");
  const body = await readCurrentBody(articleId);
  if (!body) throw new Error("Synthetic material missing");
  const factory = await prepareNewsFallback({ root: shutdownSignal.signal, expected: body, current: () => readCurrentBody(articleId), articles: [body] });
  if (!factory) throw new Error("Synthetic material permission missing");
  return factory(request);
}
