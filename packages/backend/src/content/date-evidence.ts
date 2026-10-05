import { MaterialSourceDateInput, type SourceDateParseResult, type SourceDateParseInput, type MaterialUpdateResult } from "@amp/contracts/time-assertion";
import { evaluateSourcePolicy, lockCurrentSourcePolicies, lockSourceDateConfiguration, parseSourceDate } from "@amp/backend/admin/sources";
import { dbOf, type Db, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { sourceDateVerdict } from "./source-time.ts";

const sql = dbOf("content");
type DateResult = Pick<MaterialUpdateResult, "revision" | "sourceTimeChanged" | "metadataChanged" | "sourceDateVersion" | "sourceDateOutcome">;

function agrees(
  primary: SourceDateParseResult,
  alternative: SourceDateParseResult,
  primaryInput: SourceDateParseInput,
  alternativeInput: SourceDateParseInput,
): boolean {
  const a = primary.evidence,
    b = alternative.evidence;
  if (alternative.reason || a.origin !== b.origin || a.publicationBasis !== b.publicationBasis) return false;
  const canonical = (utc: string) => utc.replace(/(\.\d*?[1-9])0+Z$/, "$1Z").replace(/\.0+Z$/, "Z");
  if (a.time.utc && b.time.utc) return canonical(a.time.utc) === canonical(b.time.utc);
  const declaration = (value: SourceDateParseInput) => [
    value.raw.trim(),
    value.format,
    value.formatPattern,
    value.language,
    value.timezone,
    value.timezoneEvidence,
  ];
  if (stableJson(declaration(primaryInput)) === stableJson(declaration(alternativeInput))) return true;
  const literalDay = (value: typeof a) =>
    value.format === "iso8601" ? /^\d{4}-\d{2}-\d{2}$/.test(value.time.raw.trim()) : value.format === "declared" && !value.formatPattern?.includes("HH");
  // A literal day can agree with a precise source instant without adopting its clock. Unverified
  // wall-clock candidates do not become agreement merely because normalization removed their time.
  return !!(literalDay(a) || a.time.utc) && !!(literalDay(b) || b.time.utc) && a.time.local_date === b.time.local_date;
}

/** Permission → source configuration → material: the same lock order as source editing. */
export async function prepareDateMutation(tx: Tx, sourceId: string, input: MaterialSourceDateInput): Promise<void> {
  const observation = input.sourceDateObservation;
  if (!observation) return;
  if (observation.sourceId !== sourceId) throw new Error("Source date identity mismatch");
  await lockCurrentSourcePolicies(tx, [{ sourceId, permissionVersion: input.permissionVersion! }]);
  await lockSourceDateConfiguration(tx, sourceId, observation.configHash);
  for (const capability of ["fetch", "store_metadata", "process_locally"] as const) {
    const decision = await evaluateSourcePolicy(
      {
        source_id: sourceId,
        expected_permission_version: input.permissionVersion,
        lane: "news",
        capability,
        resource: { url: observation.url, document_type: null, attachment: false },
      },
      undefined,
      tx,
    );
    if (decision.decision !== "allow") throw new Error(`Source date permission denied: ${capability}`);
  }
}

/** Keeps every observation; only a changed, current observation can advance the current version. */
export async function commitDateObservation(
  tx: Tx,
  articleId: string,
  input: MaterialSourceDateInput,
  now: number,
  expectedRevision?: number,
): Promise<DateResult> {
  const [article] = await tx<
    { source_id: string; url: string; revision: number; source_date_version: string; source_date_state: string; source_date_observation_id: string | null }[]
  >`
    SELECT source_id, url, revision, source_date_version, source_date_state, source_date_observation_id FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (!article) throw new Error("Missing material");
  const result: DateResult = {
    revision: article.revision,
    sourceDateVersion: Number(article.source_date_version),
    metadataChanged: false,
    sourceTimeChanged: false,
    sourceDateOutcome: "unchanged",
  };
  const observation = input.sourceDateObservation;
  if (!observation) return result;
  if (observation.sourceId !== article.source_id) return { ...result, sourceDateOutcome: expectedRevision === undefined ? "unchanged" : "stale" };
  if (observation.url !== article.url && (!identityKeyForUrl(observation.url) || identityKeyForUrl(observation.url) !== identityKeyForUrl(article.url)))
    throw new Error("Source date URL identity mismatch");
  const stale = () => ({ ...result, sourceDateOutcome: "stale" as const });
  const inputRevision = expectedRevision ?? article.revision;
  if (inputRevision !== article.revision) {
    const [revision] = await tx`SELECT 1 FROM article_revisions WHERE article_id = ${articleId} AND revision = ${inputRevision}`;
    if (!revision) return stale(); // Never manufacture a material revision merely to retain evidence.
  }
  const [previous] = await tx<{ semantic_hash: string; result: SourceDateParseResult; observed_at: Date }[]>`
    SELECT semantic_hash, result, observed_at FROM content.source_date_observations WHERE id = ${article.source_date_observation_id}`;
  const [recent] = await tx<{ observed_at: Date }[]>`
    SELECT observed_at FROM content.source_date_observations
    WHERE article_id = ${articleId} AND revision = ${inputRevision} AND config_hash = ${observation.configHash}
    ORDER BY observed_at DESC LIMIT 1`;
  const { sourceId, configHash, alternatives, ...raw } = observation;
  const binding = { articleId, sourceId, revision: inputRevision, configHash };
  const primaryInput = { ...raw, binding };
  const parsed = parseSourceDate(primaryInput);
  if (
    !parsed.reason &&
    alternatives?.some((candidate) => {
      if (candidate.meaning !== raw.meaning) return false;
      const input: SourceDateParseInput = { ...raw, ...candidate, binding };
      return !agrees(parsed, parseSourceDate(input), primaryInput, input);
    })
  ) {
    parsed.reason = "conflicting_candidates";
    parsed.evidence.interpretation = "conflict";
  }
  const verdict = sourceDateVerdict("news", parsed.evidence, binding, now);
  const { observationId: _id, observedAt: _at, ...facts } = parsed.evidence;
  const semanticHash = sha256(stableJson({ facts, alternatives, permissionVersion: input.permissionVersion }));
  const id = sha256(stableJson({ parsed, alternatives, permissionVersion: input.permissionVersion }));
  await tx`INSERT INTO content.source_date_observations
    (id, article_id, source_id, revision, config_hash, permission_version, observation_id, observed_at, observation, result, semantic_hash)
    VALUES (${id}, ${articleId}, ${sourceId}, ${inputRevision}, ${configHash}, ${input.permissionVersion!},
      ${raw.observationId}, ${raw.observedAt}, ${tx.json(observation)}, ${tx.json(parsed)}, ${semanticHash}) ON CONFLICT (id) DO NOTHING`;
  if (
    inputRevision !== article.revision ||
    result.sourceDateVersion !== input.expectedSourceDateVersion ||
    (recent && recent.observed_at.getTime() > Date.parse(observation.observedAt))
  )
    return stale();
  if (previous?.semantic_hash === semanticHash && article.source_date_state === verdict.status) return result;
  const old = previous ? sourceDateVerdict("news", previous.result.evidence, binding, now) : null;
  const time = verdict.status === "reliable" ? verdict.time : null;
  const oldTime = article.source_date_state === "reliable" && old?.status === "reliable" ? old.time : null;
  const updated = await tx`UPDATE articles SET source_date_version = source_date_version + 1, source_date_observation_id = ${id},
    source_date_state = ${verdict.status}, source_date_error = ${verdict.status === "pending" ? (parsed.reason ?? verdict.reason) : null},
    published_at = ${time?.utc ?? null}, published_at_claim = ${time?.utc ?? null}
    WHERE id = ${articleId} AND revision = ${article.revision} AND source_date_version = ${result.sourceDateVersion}
    RETURNING source_date_version`;
  if (updated.length !== 1) throw new Error("Source date version changed during commit");
  return {
    ...result,
    sourceDateVersion: result.sourceDateVersion + 1,
    sourceDateOutcome: "applied",
    metadataChanged: true,
    sourceTimeChanged: stableJson(oldTime) !== stableJson(time),
  };
}

export async function updateMaterialSourceDate(articleId: string, expectedRevision: number, input: MaterialSourceDateInput): Promise<DateResult> {
  const value = MaterialSourceDateInput.parse(input);
  if (!value.sourceDateObservation) throw new Error("Date observation required");
  return sql.begin(async (tx) => {
    await prepareDateMutation(tx, value.sourceDateObservation!.sourceId, value);
    return commitDateObservation(tx, articleId, value, Date.now(), expectedRevision);
  });
}

/** A reader obtains the actual material/evidence identity; it never assigns an observation to a newer revision. */
export async function materialDateHeads(sourceId: string, urls: string[], db: Db = sql) {
  if (!urls.length) return [];
  return db<{ id: string; url: string; revision: number; source_date_version: string }[]>`
    SELECT id, url, revision, source_date_version FROM articles WHERE source_id = ${sourceId} AND url IN ${db(urls)}`;
}
