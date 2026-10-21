import { correctedSourceTime } from "./date-correction.ts";
import { beijingMidnight } from "@amp/contracts/time";
import { decideTimeline } from "./timeline.ts";
import { beginMaterialGrouping } from "./grouping.ts";
import {
  MaterialSourceDateInput,
  type SourceDateParseResult,
  type SourceDateParseInput,
  type MaterialUpdateResult,
  type SourceDateObservationInput,
} from "@amp/contracts/time-assertion";
import {
  readSourceDateContext,
  evaluateSourcePolicy,
  lockCurrentSourcePolicies,
  lockSourceDateConfiguration,
  parseSourceDate,
} from "@amp/backend/admin/sources";
import { sql, type Db, type Tx, type Sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { sourceDateVerdict } from "./source-time.ts";
import { sourceDateReadingsAgree } from "../sources/date-extraction.ts";

type DateResult = Pick<MaterialUpdateResult, "revision" | "sourceTimeChanged" | "metadataChanged" | "sourceDateVersion" | "sourceDateOutcome">;
const ABSENT_LISTING_FIELD = "listing publication field absent";
const absentListingDate = (observation: SourceDateObservationInput, parsed: SourceDateParseResult) =>
  observation.locator === ABSENT_LISTING_FIELD && observation.raw === "" && parsed.reason === "missing" && !observation.alternatives?.length;

/** Permission → source configuration → material: the same lock order as source editing. */
export async function prepareDateMutation(tx: Tx, sourceId: string, input: MaterialSourceDateInput): Promise<void> {
  const observation = input.sourceDateObservation;
  if (!observation) return;
  if (observation.sourceId !== sourceId) throw new Error("Source date identity mismatch");
  await lockCurrentSourcePolicies(tx, [{ sourceId, permissionVersion: input.permissionVersion! }]);
  await lockSourceDateConfiguration(tx, sourceId, observation.configHash);
  const source = await readSourceDateContext(sourceId, tx);
  if (!source) throw new Error("Source date source missing");
  for (const capability of ["fetch", "store_metadata", "process_locally"] as const) {
    const decision = await evaluateSourcePolicy(
      {
        source_id: sourceId,
        expected_permission_version: input.permissionVersion,
        lane: source.lane,
        capability,
        resource: { url: observation.url, document_type: null, attachment: false },
      },
      undefined,
      tx,
    );
    if (decision.decision !== "allow")
      throw new Error(`Source date permission denied: ${capability}/${decision.reason} (${new URL(observation.url).hostname})`);
  }
}

/** Retain changed evidence and the last time seen; only current observations advance the current version. */
export async function commitDateObservation(
  tx: Tx,
  articleId: string,
  input: MaterialSourceDateInput,
  now: number,
  expectedRevision?: number,
): Promise<DateResult> {
  const [article] = await tx<
    {
      discovered_at: Date;
      published_at: Date | null;
      timeline_at: Date;
      backfill: boolean;
      backfill_reason: string | null;
      source_id: string;
      url: string;
      revision: number;
      source_date_version: string;
      source_date_state: string;
      source_date_observation_id: string | null;
    }[]
  >`
    SELECT discovered_at,published_at,timeline_at,backfill,backfill_reason,source_id, url, revision, source_date_version, source_date_state, source_date_observation_id FROM articles WHERE id = ${articleId} FOR UPDATE`;
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
  const [previous] = await tx<{ semantic_hash: string; result: SourceDateParseResult; observation: SourceDateObservationInput; observed_at: Date }[]>`
    SELECT semantic_hash, result, observation, observed_at FROM content.source_date_observations WHERE id = ${article.source_date_observation_id}`;
  const [recent] = await tx<{ id: string; semantic_hash: string; observed_at: Date; last_observed_at: Date | null }[]>`
    SELECT o.id, o.semantic_hash, o.observed_at, s.last_observed_at FROM content.source_date_observations o
    LEFT JOIN content.source_date_observation_seen s USING (article_id, revision, config_hash)
    WHERE o.article_id = ${articleId} AND o.revision = ${inputRevision} AND o.config_hash = ${observation.configHash}
    ORDER BY o.observed_at DESC, o.created_at DESC, o.id DESC LIMIT 1`;
  const { sourceId, configHash, alternatives, ...raw } = observation;
  const binding = { articleId, sourceId, revision: inputRevision, configHash };
  const primaryInput = { ...raw, binding };
  const parsed = parseSourceDate(primaryInput);
  if (
    !parsed.reason &&
    alternatives?.some((candidate) => {
      if (candidate.meaning !== raw.meaning) return false;
      const input: SourceDateParseInput = { ...raw, ...candidate, binding };
      return !sourceDateReadingsAgree(parsed, parseSourceDate(input), primaryInput, input);
    })
  ) {
    parsed.reason = "conflicting_candidates";
    parsed.evidence.interpretation = "conflict";
  }
  const source = await readSourceDateContext(sourceId, tx);
  if (!source) throw new Error("Source date source missing");
  // Policy owns date semantics. Persist the selected observation without applying news publication rules.
  let verdict =
    source.lane === "policy"
      ? { status: "pending" as const, reason: "not_source_publication" as const }
      : sourceDateVerdict("news", parsed.evidence, binding, now);
  const { observationId: _id, observedAt: _at, ...facts } = parsed.evidence;
  const semanticHash = sha256(stableJson({ facts, alternatives, permissionVersion: input.permissionVersion }));
  const id = recent?.semantic_hash === semanticHash ? recent.id : sha256(stableJson({ parsed, alternatives, permissionVersion: input.permissionVersion }));
  if (id !== recent?.id)
    await tx`INSERT INTO content.source_date_observations
    (id, article_id, source_id, revision, config_hash, permission_version, observation_id, observed_at, observation, result, semantic_hash)
    VALUES (${id}, ${articleId}, ${sourceId}, ${inputRevision}, ${configHash}, ${input.permissionVersion!},
      ${raw.observationId}, ${raw.observedAt}, ${tx.json(observation)}, ${tx.json(parsed)}, ${semanticHash}) ON CONFLICT (id) DO NOTHING`;
  await tx`INSERT INTO content.source_date_observation_seen(article_id, revision, config_hash, last_observed_at)
    VALUES (${articleId}, ${inputRevision}, ${configHash}, ${raw.observedAt})
    ON CONFLICT (article_id, revision, config_hash) DO UPDATE SET
      last_observed_at = greatest(content.source_date_observation_seen.last_observed_at, EXCLUDED.last_observed_at), updated_at = now()`;
  if (
    inputRevision !== article.revision ||
    result.sourceDateVersion !== input.expectedSourceDateVersion ||
    (recent && Math.max(recent.observed_at.getTime(), recent.last_observed_at?.getTime() ?? -Infinity) > Date.parse(observation.observedAt))
  )
    return stale();
  if ((await correctedSourceTime(articleId, tx)) !== undefined) return result;
  const old = previous && source.lane === "news" ? sourceDateVerdict("news", previous.result.evidence, binding, now) : null;
  const urlIdentity = identityKeyForUrl(article.url);
  const sameUrl = (url: string) => url === article.url || (!!urlIdentity && identityKeyForUrl(url) === urlIdentity);
  // A list with no configured date field says nothing about the date already read from its detail.
  // The missing observation and seen time above remain auditable; all CAS/permission checks still apply.
  if (
    absentListingDate(observation, parsed) &&
    article.source_date_state === "reliable" &&
    old?.status === "reliable" &&
    sameUrl(previous!.result.evidence.url)
  )
    return result;
  let selectedId = id;
  if (
    absentListingDate(observation, parsed) &&
    article.source_date_state === "pending" &&
    old?.status === "pending" &&
    old.reason === "unresolved" &&
    previous &&
    absentListingDate(previous.observation, previous.result) &&
    sameUrl(previous.result.evidence.url)
  ) {
    // Repair only this known loss on a later natural observation. The latest other observation
    // is a barrier: an explicit missing/conflicting date must never be skipped for an older date.
    const [candidate] = await tx<{ id: string; result: SourceDateParseResult }[]>`
      SELECT id,result FROM content.source_date_observations
      WHERE article_id=${articleId} AND source_id=${sourceId} AND revision=${inputRevision} AND config_hash=${configHash}
        AND NOT COALESCE(observation->>'locator'=${ABSENT_LISTING_FIELD} AND observation->>'raw'=''
          AND result->>'reason'='missing' AND COALESCE(observation->'alternatives','[]'::jsonb)='[]'::jsonb, false)
      ORDER BY observed_at DESC,created_at DESC,id DESC LIMIT 1`;
    const recovered = candidate ? sourceDateVerdict("news", candidate.result.evidence, binding, now) : null;
    if (recovered?.status === "reliable" && sameUrl(candidate!.result.evidence.url)) {
      verdict = recovered;
      selectedId = candidate!.id;
    }
  }
  if (previous?.semantic_hash === semanticHash && article.source_date_state === verdict.status) return result;
  const time = verdict.status === "reliable" ? verdict.time : null;
  // Midnight is an internal calendar anchor; the source TimeAssertion still has no UTC or clock time for a day-only source.
  const publishedAt = time?.utc ? new Date(time.utc) : time?.local_date ? beijingMidnight(time.local_date) : null;
  const automatic = ["unknown-publication-time", "stale-on-discovery"].includes(article.backfill_reason ?? "");
  const explicit = automatic ? null : (article.backfill_reason ?? (article.backfill ? "existing-backfill" : null));
  const timeline = decideTimeline(publishedAt, article.discovered_at, explicit);
  const oldTime = article.source_date_state === "reliable" && old?.status === "reliable" ? old.time : null;
  const updated = await tx`UPDATE articles SET source_date_version = source_date_version + 1, source_date_observation_id = ${selectedId},
    source_date_state = ${verdict.status}, source_date_error = ${verdict.status === "pending" ? (parsed.reason ?? verdict.reason) : null},
    published_at = ${timeline.publishedAt}, published_at_claim = ${publishedAt},
    timeline_at=${timeline.timelineAt},backfill=${timeline.backfill},backfill_reason=${timeline.backfillReason}
    WHERE id = ${articleId} AND revision = ${article.revision} AND source_date_version = ${result.sourceDateVersion}
    RETURNING source_date_version`;
  if (updated.length !== 1) throw new Error("Source date version changed during commit");
  const timeIdentity = (value: typeof time) => stableJson(value ? [value.precision, value.utc, value.local_date, value.local_time, value.timezone] : null);
  const sourceTimeChanged = timeIdentity(oldTime) !== timeIdentity(time);
  if (sourceTimeChanged) await beginMaterialGrouping(articleId, article.revision, true, tx);
  return {
    ...result,
    sourceDateVersion: result.sourceDateVersion + 1,
    sourceDateOutcome: "applied",
    metadataChanged: true,
    sourceTimeChanged,
  };
}

/** Migration-only maintenance: preview writes nothing; each apply locks one material before choosing deletions. */
export async function compactDateObservations(db: Sql, { apply = false }: { apply?: boolean } = {}) {
  const materials = await db<{ article_id: string }[]>`SELECT DISTINCT article_id FROM content.source_date_observations ORDER BY article_id`;
  const rows: { articleId: string; before: number; after: number; removable: number; bytes: number }[] = [];
  for (const { article_id: articleId } of materials) {
    const inspect = async (tx: Db) => {
      if (apply) await tx`SELECT id FROM articles WHERE id = ${articleId} FOR UPDATE`;
      const [current] = await tx<{ source_date_observation_id: string | null }[]>`SELECT source_date_observation_id FROM articles WHERE id = ${articleId}`;
      const observed = await tx<{ id: string; revision: number; config_hash: string; semantic_hash: string; observed_at: Date; bytes: number }[]>`
        SELECT id, revision, config_hash, semantic_hash, observed_at, pg_catalog.pg_column_size(o)::int AS bytes FROM content.source_date_observations o
        WHERE article_id = ${articleId} ORDER BY revision, config_hash, observed_at, created_at, id`;
      const same = (a: (typeof observed)[number] | undefined, b: (typeof observed)[number]) =>
        a?.revision === b.revision && a.config_hash === b.config_hash && a.semantic_hash === b.semantic_hash;
      const remove = observed.filter((row, i) => row.id !== current?.source_date_observation_id && same(observed[i - 1], row) && same(observed[i + 1], row));
      if (apply) {
        const latest = new Map(observed.map((row) => [`${row.revision}:${row.config_hash}`, row]));
        for (const row of latest.values())
          await tx`INSERT INTO content.source_date_observation_seen(article_id, revision, config_hash, last_observed_at)
          VALUES (${articleId}, ${row.revision}, ${row.config_hash}, ${row.observed_at})
          ON CONFLICT (article_id, revision, config_hash) DO UPDATE SET
            last_observed_at = greatest(content.source_date_observation_seen.last_observed_at, EXCLUDED.last_observed_at), updated_at = now()`;
        if (remove.length) await tx`DELETE FROM content.source_date_observations WHERE article_id = ${articleId} AND id IN ${tx(remove.map((row) => row.id))}`;
      }
      return {
        articleId,
        before: observed.length,
        after: observed.length - (apply ? remove.length : 0),
        removable: remove.length,
        bytes: remove.reduce((n, row) => n + row.bytes, 0),
      };
    };
    rows.push(apply ? await db.begin(inspect) : await inspect(db));
  }
  return {
    apply,
    totalRows: rows.reduce((n, row) => n + row.before, 0),
    remainingRows: rows.reduce((n, row) => n + row.after, 0),
    removableRows: rows.reduce((n, row) => n + row.removable, 0),
    estimatedMB: rows.reduce((n, row) => n + row.bytes, 0) / 1024 ** 2,
    topMaterials: [...rows].sort((a, b) => b.removable - a.removable || a.articleId.localeCompare(b.articleId)).slice(0, 10),
    materials: rows,
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

/** Selected source date evidence only. Publication receives no locator, excerpt, permission record or parser state. */
export async function materialSourceTime(
  binding: { articleId: string; sourceId: string; revision: number; configHash: string },
  dateVersion: number,
  now: number,
  db: Db = sql,
) {
  const corrected = await correctedSourceTime(binding.articleId, db);
  if (corrected !== undefined) return corrected;
  if (!Number.isSafeInteger(dateVersion) || dateVersion <= 0) return null;
  const [row] = await db<
    { result: SourceDateParseResult }[]
  >`SELECT o.result FROM articles a JOIN content.source_date_observations o ON o.id=a.source_date_observation_id
    WHERE a.id=${binding.articleId} AND a.source_id=${binding.sourceId} AND a.revision=${binding.revision} AND a.source_date_version=${dateVersion}
      AND a.source_date_state='reliable' AND o.article_id=a.id AND o.source_id=a.source_id AND o.revision=a.revision AND o.config_hash=${binding.configHash}`;
  const verdict = sourceDateVerdict("news", row?.result?.evidence, binding, now);
  return verdict.status === "reliable" ? verdict.time : null;
}
