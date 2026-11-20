// The entity library in the database (schema `entities`). This file and admin.ts are the only ones that query its
// tables (scripts/verify/data-ownership-map.json registers both to the module `entities`); other modules call the
// functions here. The worker reads the library and replaces the links it finds in an article; the library itself is
// changed only by the seed and by people (admin.ts). Every write to entities or statements sets updated_at: the
// index kept in memory is rebuilt when the row counts or the latest updated_at change.
import { type Db, sql } from "../../db.ts";
import { buildIndex, type EntityIndex, LINKER_VERSION } from "./link.ts";
import type { EntityLink, EntityRow, StatementRow } from "./model.ts";
import { aliasKey } from "./normalize.ts";
import { type SeedRows, seedRows } from "./seed.ts";

export interface LoadedIndex {
  index: EntityIndex;
  /**
   * database: built from the tables. code_seed: the tables hold no entity yet (scripts/entities-seed.ts has not run),
   * so the index is built in memory from the companies the code already lists. Nothing waits for the seed; links found
   * with the code seed are simply not stored, because their ids are not rows yet (replaceArticleLinks).
   */
  source: "database" | "code_seed";
}

/** A rebuild at least this often, should a write ever leave updated_at as it was. */
const REBUILD_MS = 10 * 60_000;
let cached: { stamp: string; at: number; loaded: LoadedIndex } | null = null;
let codeSeed: LoadedIndex | null = null;

/**
 * The library as one index. The two tables are read whole, which is bounded by the size of the library (hundreds of
 * companies, a few thousand spellings), and only when their row counts or latest updated_at moved or ten minutes
 * passed; otherwise one small query answers from memory.
 */
export async function loadEntityIndex(db: Db = sql, now = Date.now()): Promise<LoadedIndex> {
  const [state] = await db<{ entities: number; statements: number; entities_at: Date | null; statements_at: Date | null }[]>`
    SELECT (SELECT count(*) FROM entities.entities)::int AS entities, (SELECT max(updated_at) FROM entities.entities) AS entities_at,
      (SELECT count(*) FROM entities.statements)::int AS statements, (SELECT max(updated_at) FROM entities.statements) AS statements_at`;
  if (!state?.entities) {
    if (!codeSeed) {
      const seed = seedRows();
      codeSeed = { index: buildIndex(seed.entities, seed.statements), source: "code_seed" };
    }
    return codeSeed;
  }
  const stamp = [state.entities, state.statements, state.entities_at?.toISOString(), state.statements_at?.toISOString()].join("/");
  if (cached?.stamp === stamp && now - cached.at < REBUILD_MS) return cached.loaded;
  const entities = await db<
    {
      id: string;
      kind: EntityRow["kind"];
      name_zh: string | null;
      name_original: string;
      show_original: boolean;
      origin: EntityRow["origin"];
      status: EntityRow["status"];
      merged_into: string | null;
    }[]
  >`SELECT id, kind, name_zh, name_original, show_original, origin, status, merged_into FROM entities.entities ORDER BY id`;
  const statements = await db<
    {
      entity_id: string;
      property: StatementRow["property"];
      value: string;
      scope: StatementRow["scope"];
      lang: string | null;
      case_sensitive: boolean;
      origin: StatementRow["origin"];
      status: StatementRow["status"];
    }[]
  >`SELECT entity_id, property, value, scope, lang, case_sensitive, origin, status FROM entities.statements ORDER BY id`;
  const index = buildIndex(
    entities.map((r) => ({
      id: r.id,
      kind: r.kind,
      nameZh: r.name_zh,
      nameOriginal: r.name_original,
      showOriginal: r.show_original,
      origin: r.origin,
      status: r.status,
      mergedInto: r.merged_into,
    })),
    statements.map((r) => ({
      entityId: r.entity_id,
      property: r.property,
      value: r.value,
      scope: r.scope,
      lang: r.lang,
      caseSensitive: r.case_sensitive,
      origin: r.origin,
      status: r.status,
    })),
  );
  cached = { stamp, at: now, loaded: { index, source: "database" } };
  return cached.loaded;
}

/**
 * The links of one article revision, replaced as a set: every earlier link of that revision goes except those a person
 * made (method manual), then the new ones are written. A link whose entity is not a row of entities.entities is left
 * out rather than failing the write, so an index built from the code seed, or one loaded before an entity changed,
 * can never break the caller. Returns how many links were stored.
 */
export async function replaceArticleLinks(
  tx: Db,
  article: { articleId: string; revision: number; lane: "news" | "policy"; analysisId: number | null },
  links: readonly EntityLink[],
): Promise<number> {
  await tx`DELETE FROM entities.article_links
    WHERE article_id = ${article.articleId} AND input_revision = ${article.revision} AND method <> 'manual'`;
  const own = links
    .filter((link) => link.method !== "manual")
    .map((l) => ({ entity_id: l.entityId, role: l.role, method: l.method, alias: l.alias, segment: l.segment, position: l.position, hits: l.hits }));
  if (!own.length) return 0;
  // Rows travel as one JSON document: a driver array would turn a null into the text "NULL".
  const rows = await tx<{ entity_id: string }[]>`
    INSERT INTO entities.article_links
      (article_id, input_revision, entity_id, lane, role, method, alias, segment, position, hits, linker_version, analysis_id)
    SELECT ${article.articleId}::text, ${article.revision}::int, l.entity_id, ${article.lane}::text, l.role, l.method, l.alias, l.segment,
      l.position, l.hits, ${LINKER_VERSION}::text, ${article.analysisId}::bigint
    FROM pg_catalog.jsonb_to_recordset(${tx.json(own)}) AS l(entity_id text, role text, method text, alias text, segment text, position integer, hits integer)
    WHERE EXISTS (SELECT 1 FROM entities.entities e WHERE e.id = l.entity_id)
    ON CONFLICT (article_id, input_revision, entity_id, method) DO NOTHING
    RETURNING entity_id`;
  return rows.length;
}

/**
 * For the daily reconciliation: how many of the given article revisions have at least one link the program found
 * (anything but a person's manual link), and how many entities the library holds (0: the seed has not run).
 */
export async function articleLinkCoverage(
  articles: ReadonlyArray<{ articleId: string; revision: number }>,
  db: Db = sql,
): Promise<{ linked: number; library: number }> {
  const [row] = await db<{ linked: number; library: number }[]>`
    SELECT (SELECT count(*) FROM entities.entities)::int AS library,
      (SELECT count(DISTINCT l.article_id)
        FROM unnest(${articles.map((a) => a.articleId)}::text[], ${articles.map((a) => a.revision)}::int[]) AS a(article_id, input_revision)
        JOIN entities.article_links l ON l.article_id = a.article_id AND l.input_revision = a.input_revision
        WHERE l.method <> 'manual')::int AS linked`;
  return { linked: row?.linked ?? 0, library: row?.library ?? 0 };
}

export interface SeedOutcome {
  entities: { seed: number; present: number; added: number };
  statements: { seed: number; present: number; added: number };
}

/**
 * Writes the seed rows that are absent and never changes a row that is there: after the first load the database is
 * the truth, as for sources. Without `apply` nothing is written and `added` is what would be added. A statement is the
 * same row when its entity, property and spelling key (aliasKey) are, as the table's unique key says.
 */
export async function seedEntityLibrary(rows: SeedRows, actor: string, opts: { apply: boolean }): Promise<SeedOutcome> {
  if (rows.entities.some((e) => e.mergedInto !== null)) throw new Error("seed entities are never merged");
  const statements = rows.statements.map((s) => ({ ...s, norm: aliasKey(s.value) }));
  const key = (entityId: string, property: string, norm: string) => `${entityId}\u0000${property}\u0000${norm}`;
  const ids = rows.entities.map((e) => e.id);
  if (!opts.apply) {
    const present = new Set((await sql<{ id: string }[]>`SELECT id FROM entities.entities WHERE id = ANY(${ids}::text[])`).map((r) => r.id));
    const stored = new Set(
      (
        await sql<{ entity_id: string; property: string; norm: string }[]>`
          SELECT entity_id, property, norm FROM entities.statements WHERE entity_id = ANY(${[...new Set(statements.map((s) => s.entityId))]}::text[])`
      ).map((r) => key(r.entity_id, r.property, r.norm)),
    );
    const known = statements.filter((s) => stored.has(key(s.entityId, s.property, s.norm))).length;
    return {
      entities: { seed: ids.length, present: present.size, added: ids.length - present.size },
      statements: { seed: statements.length, present: known, added: statements.length - known },
    };
  }
  // Rows travel as JSON documents (a driver array would turn a null into the text "NULL"), inserted in seed order.
  const entityRows = rows.entities.map((e) => ({
    id: e.id,
    kind: e.kind,
    name_zh: e.nameZh,
    name_original: e.nameOriginal,
    show_original: e.showOriginal,
    origin: e.origin,
    status: e.status,
  }));
  const statementRows = statements.map((s) => ({
    entity_id: s.entityId,
    property: s.property,
    value: s.value,
    norm: s.norm,
    scope: s.scope,
    lang: s.lang,
    case_sensitive: s.caseSensitive,
    origin: s.origin,
    status: s.status,
  }));
  return sql.begin(async (tx) => {
    const entities = await tx<{ id: string }[]>`
      INSERT INTO entities.entities (id, kind, name_zh, name_original, show_original, origin, status, updated_by)
      SELECT s.id, s.kind, s.name_zh, s.name_original, s.show_original, s.origin, s.status, ${actor}::text
      FROM pg_catalog.jsonb_to_recordset(${tx.json(entityRows)})
        AS s(id text, kind text, name_zh text, name_original text, show_original boolean, origin text, status text)
      ON CONFLICT (id) DO NOTHING
      RETURNING id`;
    const added = await tx<{ id: number }[]>`
      INSERT INTO entities.statements (entity_id, property, value, norm, scope, lang, case_sensitive, origin, status, updated_by)
      SELECT s.entity_id, s.property, s.value, s.norm, s.scope, s.lang, s.case_sensitive, s.origin, s.status, ${actor}::text
      FROM pg_catalog.jsonb_to_recordset(${tx.json(statementRows)})
        AS s(entity_id text, property text, value text, norm text, scope text, lang text, case_sensitive boolean, origin text, status text)
      ON CONFLICT (entity_id, property, norm) DO NOTHING
      RETURNING id`;
    return {
      entities: { seed: ids.length, present: ids.length - entities.length, added: entities.length },
      statements: { seed: statements.length, present: statements.length - added.length, added: added.length },
    };
  });
}
