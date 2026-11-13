/**
 * The “结构化” stage of the restarted policy line (法规线重启设计 §4): after archive, split the revision's own extracted
 * original text into provisions and keep them per document revision. Deterministic and repeatable; no model call,
 * no network. A scanned original without a text layer is marked needs_manual instead of being sent to vision.
 */
import { sql, type Db } from "@amp/backend/db";
import { sha256 } from "@amp/backend/lib/ids";
import { EXTRACTION_RECIPE, extractPolicyOriginal, type ExtractionProfile, type PolicyExtraction } from "./extraction.ts";
import { readPolicyOriginal } from "./originals.ts";
import { PROVISION_RECIPE, provisionSetHash, splitProvisions, type Provision, type ProvisionNumbering } from "./provisions.ts";

export type PolicyStructureStatus = "structured" | "no_provisions" | "needs_manual";
export type PolicyStructure = {
  revisionId: string;
  recipe: string;
  status: PolicyStructureStatus;
  numbering: ProvisionNumbering | null;
  provisionsHash: string;
  provisionCount: number;
  gaps: string[];
};

/** The main document's text in extraction order: HTML blocks are paragraphs, PDF text items carry their own line ends. */
export function provisionSourceText(extraction: PolicyExtraction, mainUrl: string) {
  const main = extraction.resources.filter((resource) => resource.url === mainUrl);
  return {
    text: main.map((resource) => resource.nodes.map((node) => (node.page === undefined ? `${node.text}\n` : node.text)).join("")).join("\n"),
    gaps: main.flatMap((resource) => resource.gaps),
  };
}

const NO_TEXT_LAYER = /无可核验文字层|无法完整解析|原件未取得|文件格式尚未支持|解码|容量超限/;
/** Pure classification for one revision's text; exported for the backfill dry run. */
export function structureFromText(text: string, gaps: string[], language: string | null) {
  const split = splitProvisions(text, { language });
  const status: PolicyStructureStatus = split.provisions.length
    ? "structured"
    : !text.trim() || gaps.some((gap) => NO_TEXT_LAYER.test(gap))
      ? "needs_manual"
      : "no_provisions";
  return { split, status, sourceHash: sha256(text) };
}

async function readStructure(revisionId: string, db: Db = sql): Promise<PolicyStructure | null> {
  const [row] = await db<
    { status: PolicyStructureStatus; numbering: ProvisionNumbering | null; provisions_hash: string; provision_count: number; gaps: string[] }[]
  >`SELECT status,numbering,provisions_hash,provision_count,gaps FROM policy.revision_structures WHERE revision_id=${revisionId} AND recipe=${PROVISION_RECIPE}`;
  return row
    ? {
        revisionId,
        recipe: PROVISION_RECIPE,
        status: row.status,
        numbering: row.numbering,
        provisionsHash: row.provisions_hash,
        provisionCount: row.provision_count,
        gaps: row.gaps,
      }
    : null;
}

/** Store one revision's structure once per recipe; a repeated run returns the stored result unchanged. */
export async function storePolicyStructure(revisionId: string, text: string, gaps: string[], language: string | null): Promise<PolicyStructure> {
  const { split, status, sourceHash } = structureFromText(text, gaps, language);
  const provisionsHash = provisionSetHash(split.provisions);
  const kept = [...new Set(gaps)].slice(0, 20);
  await sql.begin(async (tx) => {
    const inserted = await tx`INSERT INTO policy.revision_structures(revision_id,recipe,status,numbering,source_hash,provisions_hash,provision_count,gaps)
      VALUES(${revisionId},${PROVISION_RECIPE},${status},${status === "structured" ? split.numbering : null},${sourceHash},${provisionsHash},${split.provisions.length},${tx.json(kept)})
      ON CONFLICT(revision_id,recipe) DO NOTHING RETURNING revision_id`;
    if (!inserted.length) return;
    for (const p of split.provisions)
      await tx`INSERT INTO policy.revision_provisions(revision_id,recipe,ordinal,provision_key,label,path,heading,body,sha256)
        VALUES(${revisionId},${PROVISION_RECIPE},${p.ordinal},${p.key},${p.label},${tx.json(p.path)},${p.heading},${p.text},${p.hash})`;
  });
  return (await readStructure(revisionId))!;
}

/** Archive → structure for the current head of one expression. Reuses the cached extraction; never calls a model. */
export async function structurePolicyRevision(expressionId: string, profile: ExtractionProfile): Promise<PolicyStructure | null> {
  const snapshot = await readPolicyOriginal(expressionId);
  if (!snapshot) return null;
  const existing = await readStructure(snapshot.revisionId);
  if (existing) return existing;
  const main = snapshot.manifest.resources[0];
  if (!main || !snapshot.resources[0]?.body) return storePolicyStructure(snapshot.revisionId, "", ["正文原件未存档"], snapshot.language);
  const extraction = await extractPolicyOriginal(expressionId, profile);
  if (extraction.revisionId !== snapshot.revisionId) return null;
  const source = provisionSourceText(extraction, main.url);
  return storePolicyStructure(snapshot.revisionId, source.text, source.gaps, snapshot.language);
}

/**
 * Backfill for revisions acquired before this stage existed: uses the newest cached extraction of that exact revision
 * (history included, since only the current head can be re-extracted). Dry runs compute without writing.
 */
export async function backfillPolicyStructures(options: { apply: boolean; limit?: number; after?: string }) {
  const rows = await sql<{ id: string; language: string; manifest: { resources: { url: string }[] } }[]>`
    SELECT r.id,e.language,r.manifest FROM policy.document_revisions r JOIN policy.expressions e ON e.id=r.expression_id
    WHERE r.id>${options.after ?? ""} AND NOT EXISTS (SELECT 1 FROM policy.revision_structures s WHERE s.revision_id=r.id AND s.recipe=${PROVISION_RECIPE})
    ORDER BY r.id LIMIT ${options.limit ?? 500}`;
  const results: { revisionId: string; status: PolicyStructureStatus | "no_extraction"; provisions: number; numbering: ProvisionNumbering | null }[] = [];
  for (const row of rows) {
    const [cached] = await sql<{ result: PolicyExtraction }[]>`SELECT result FROM policy.document_extractions WHERE revision_id=${row.id}
      ORDER BY (recipe=${EXTRACTION_RECIPE}) DESC,created_at DESC LIMIT 1`;
    const mainUrl = row.manifest.resources[0]?.url;
    if (!cached || !mainUrl) {
      results.push({ revisionId: row.id, status: "no_extraction", provisions: 0, numbering: null });
      continue;
    }
    const source = provisionSourceText(cached.result, mainUrl);
    if (options.apply) {
      const stored = await storePolicyStructure(row.id, source.text, source.gaps, row.language);
      results.push({ revisionId: row.id, status: stored.status, provisions: stored.provisionCount, numbering: stored.numbering });
    } else {
      const { split, status } = structureFromText(source.text, source.gaps, row.language);
      results.push({ revisionId: row.id, status, provisions: split.provisions.length, numbering: split.numbering });
    }
  }
  return { results, next: rows.length === (options.limit ?? 500) ? rows.at(-1)!.id : null };
}

/**
 * The main document's text of one revision from its newest cached extraction (the instrument gate and the rule-based
 * procedure read it). Never extracts, fetches or calls a model; "" when nothing was extracted (e.g. full text not allowed).
 */
export async function readCachedPolicyText(revisionId: string, db: Db = sql): Promise<string> {
  const [row] = await db<{ result: PolicyExtraction; manifest: { resources: { url: string }[] } }[]>`
    SELECT x.result,r.manifest FROM policy.document_extractions x JOIN policy.document_revisions r ON r.id=x.revision_id
    WHERE x.revision_id=${revisionId} ORDER BY (x.recipe=${EXTRACTION_RECIPE}) DESC,x.created_at DESC LIMIT 1`;
  const mainUrl = row?.manifest.resources[0]?.url;
  return row && mainUrl ? provisionSourceText(row.result, mainUrl).text : "";
}

/** Stored provisions of one revision, in document order; null when the revision has not been structured. */
export async function readPolicyProvisions(revisionId: string, db: Db = sql): Promise<{ structure: PolicyStructure; provisions: Provision[] } | null> {
  const structure = await readStructure(revisionId, db);
  if (!structure) return null;
  const rows = await db<{ ordinal: number; provision_key: string; label: string; path: string[]; heading: string | null; body: string; sha256: string }[]>`
    SELECT ordinal,provision_key,label,path,heading,body,sha256 FROM policy.revision_provisions WHERE revision_id=${revisionId} AND recipe=${PROVISION_RECIPE} ORDER BY ordinal`;
  return {
    structure,
    provisions: rows.map((r) => ({ ordinal: r.ordinal, key: r.provision_key, label: r.label, path: r.path, heading: r.heading, text: r.body, hash: r.sha256 })),
  };
}
