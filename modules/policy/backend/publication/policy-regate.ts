/**
 * Re-gate what is already public (TASK-0576, Owner 2026-11-07 “同意”): the same instrument gate the publisher applies,
 * run over every document's newest edition. A dry run (the default) only counts; --apply hides failing documents through
 * automatic_excluded with the gate's reason (reversible, never deletes an edition); --restore lifts exactly the holds the
 * gate set. Manual withdrawals and verified model exclusions are never touched. No model, no network.
 */
import { sql } from "@amp/backend/db";
import { classifyInstrument, INSTRUMENT_GATE_REASON_ZH, type InstrumentGateResult } from "../domain/instrument-gate.ts";
import { readCachedPolicyText } from "../domain/provision-store.ts";
import { observedPolicyDocumentType } from "../domain/metadata.ts";
import { applyInstrumentGate } from "./policies-publish.ts";
import { audit } from "@amp/backend/admin/auth";

const ACTOR = "system:policy-regate";
type Row = {
  policy_id: string;
  source_id: string;
  source_language: string;
  native_revision_id: string;
  card: { original_title: string; instrument_number: string | null; authority: { name: string } } | null;
  withdrawn: boolean;
  automatic_excluded: boolean;
  instrument_gate_hold: unknown;
};
export type RegateSample = { policyId: string; sourceId: string; title: string; kind: string; reason: string; detail: string };
export type RegateReport = {
  mode: "dry-run" | "apply" | "restore";
  documents: number;
  passing: number;
  failing: number;
  /** Failing documents that are (or would be) newly hidden, and gate holds that are (or would be) lifted. */
  hide: number;
  release: number;
  skipped: { withdrawn: number; modelExcluded: number };
  bySource: Record<string, number>;
  byKind: Record<string, number>;
  byReason: Record<string, number>;
  samples: RegateSample[];
};

const bump = (map: Record<string, number>, key: string) => {
  map[key] = (map[key] ?? 0) + 1;
};

/** The gate's answer for one stored document (newest edition, the document type observed with that revision, cached text). */
export async function gateStoredDocument(row: Pick<Row, "card" | "source_language" | "source_id" | "native_revision_id">) {
  const text = await readCachedPolicyText(row.native_revision_id);
  const documentType = await observedPolicyDocumentType(row.native_revision_id);
  return classifyInstrument({
    title: row.card?.original_title ?? "",
    number: row.card?.instrument_number ?? null,
    issuer: row.card?.authority.name ?? null,
    excerpt: text.slice(0, 8000),
    documentType,
    language: row.source_language,
    sourceId: row.source_id,
  });
}

export async function regatePolicyDocuments(options: { mode: "dry-run" | "apply" | "restore" }): Promise<RegateReport> {
  const rows = await sql<Row[]>`
    SELECT DISTINCT ON (e.policy_id) e.policy_id,e.source_id,e.source_language,e.native_revision_id,coalesce(e.basic_card,e.complete_card) AS card,
      d.withdrawn,d.automatic_excluded,d.instrument_gate_hold
    FROM publication.policy_editions e JOIN publication.policy_documents d ON d.id=e.policy_id
    ORDER BY e.policy_id,e.released_at DESC,e.id DESC`;
  const report: RegateReport = {
    mode: options.mode,
    documents: rows.length,
    passing: 0,
    failing: 0,
    hide: 0,
    release: 0,
    skipped: { withdrawn: 0, modelExcluded: 0 },
    bySource: {},
    byKind: {},
    byReason: {},
    samples: [],
  };
  for (const row of rows) {
    if (options.mode === "restore") {
      if (!row.instrument_gate_hold) continue;
      report.release++;
      await sql.begin(async (tx) => {
        const [doc] = await tx`SELECT instrument_gate_hold FROM publication.policy_documents WHERE id=${row.policy_id} FOR UPDATE`;
        if (!doc?.instrument_gate_hold) return;
        await tx`UPDATE publication.policy_documents SET automatic_excluded=false,instrument_gate_hold=NULL,updated_at=now() WHERE id=${row.policy_id}`;
        await audit(
          ACTOR,
          "policy.instrument_gate.restore",
          `policy:${row.policy_id}`,
          "撤销法规清理：恢复程序判定隐藏的条目",
          doc.instrument_gate_hold,
          null,
          undefined,
          tx,
        );
      });
      continue;
    }
    if (row.withdrawn) {
      report.skipped.withdrawn++;
      continue;
    }
    const gate: InstrumentGateResult = await gateStoredDocument(row);
    if (gate.publishable) {
      report.passing++;
      if (row.instrument_gate_hold) report.release++;
    } else {
      report.failing++;
      bump(report.bySource, row.source_id);
      bump(report.byKind, gate.kind);
      bump(report.byReason, `${gate.reason}（${INSTRUMENT_GATE_REASON_ZH[gate.reason]}）`);
      if (report.samples.length < 10)
        report.samples.push({
          policyId: row.policy_id,
          sourceId: row.source_id,
          title: row.card?.original_title ?? "",
          kind: gate.kind,
          reason: gate.reason,
          detail: gate.detail,
        });
      if (row.automatic_excluded && !row.instrument_gate_hold) report.skipped.modelExcluded++;
      else if (!row.instrument_gate_hold) report.hide++;
    }
    if (options.mode === "apply")
      await sql.begin(async (tx) => {
        const [doc] = await tx<{ withdrawn: boolean; automatic_excluded: boolean; instrument_gate_hold: unknown }[]>`
          SELECT withdrawn,automatic_excluded,instrument_gate_hold FROM publication.policy_documents WHERE id=${row.policy_id} FOR UPDATE`;
        if (!doc || doc.withdrawn) return;
        await applyInstrumentGate(tx, row.policy_id, doc, gate, ACTOR);
      });
  }
  return report;
}
