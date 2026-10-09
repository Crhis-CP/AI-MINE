import { assertRuntimeControl } from "../operations/lane-controls.ts";
import { randomUUID } from "node:crypto";
import { dbOf, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { identityKeyForUrl } from "@amp/backend/lib/url";
import { evaluateSourcePolicy, lockCurrentSourcePolicies, lockPolicySourceConfiguration } from "@amp/backend/admin/sources";
import { upsertMaterial, materialDateIdentityHeads } from "@amp/backend/content/materials";
import { enqueue, ensureQueue } from "@amp/backend/jobs/queue";
import { CrawlDeferred } from "./crawl.ts";
import type { SourceRow, Candidate } from "../sources/types.ts";
import type { DirectoryProfile } from "../sources/directory-profile.ts";
import type { DirectoryPage, DirectoryEntry, DirectoryFailureEvidence } from "../sources/directory-page.ts";
const sql = dbOf("acquisition");
export type DirectoryScan = {
  id: string;
  source_id: string;
  contract_hash: string;
  permission_version: number;
  contract: DirectoryProfile;
  state: string;
  next_page: number;
  total_pages: number | null;
  total_records: number | null;
  record_count: number;
  first_fingerprint: string | null;
  retry_at: Date | null;
};
async function lock(tx: Tx, sourceId: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`policy-directory:${sourceId}`}))`;
}
async function receipt(tx: Tx, scan: DirectoryScan, outcome: "complete" | "incomplete", evidence: unknown) {
  const hash = sha256(stableJson([scan.id, outcome, evidence]));
  await tx`INSERT INTO acquisition.directory_receipts(id,scan_id,source_id,outcome,recorded_at,proof_hash,evidence)
    VALUES(${hash},${scan.id},${scan.source_id},${outcome},pg_catalog.clock_timestamp(),${hash},${tx.json(evidence as never)}) ON CONFLICT DO NOTHING`;
}
export async function beginDirectoryScan(sourceId: string, hash: string, permissionVersion: number, profile: DirectoryProfile) {
  return sql.begin(async (tx) => {
    await lock(tx, sourceId);
    const [current] = await tx<
      DirectoryScan[]
    >`SELECT * FROM acquisition.directory_scans WHERE source_id=${sourceId} AND state='running' ORDER BY started_at DESC,id LIMIT 1 FOR UPDATE`;
    if (current && current.contract_hash === hash && Number(current.permission_version) === permissionVersion) return current;
    if (current) {
      await tx`UPDATE acquisition.directory_scans SET state='obsolete',finished_at=pg_catalog.clock_timestamp(),reason='contract_or_permission_changed' WHERE id=${current.id}`;
      await receipt(tx, current, "incomplete", { reason: "contract_or_permission_changed" });
    }
    const [failed] = await tx<
      { retry_at: Date }[]
    >`SELECT retry_at FROM acquisition.directory_scans WHERE source_id=${sourceId} AND state='failed' ORDER BY started_at DESC,id LIMIT 1`;
    if (failed?.retry_at && failed.retry_at.getTime() > Date.now())
      throw new CrawlDeferred(failed.retry_at, `directory:${sourceId}`, "directory_restart_pending");
    const id = randomUUID();
    const [row] = await tx<DirectoryScan[]>`INSERT INTO acquisition.directory_scans(id,source_id,contract_hash,permission_version,contract,next_page)
      VALUES(${id},${sourceId},${hash},${permissionVersion},${tx.json(profile)},${profile.request.firstPage}) RETURNING *`;
    return row!;
  });
}
function identity(sourceId: string, profile: DirectoryProfile, entry: DirectoryEntry) {
  return `policy-directory:${sha256(stableJson([sourceId, profile.idNamespace, entry.recordId, identityKeyForUrl(entry.candidate.url)]))}`;
}
async function requireDirectoryUse(tx: Tx, scan: DirectoryScan, source: SourceRow, url: string) {
  for (const capability of ["fetch", "store_metadata", "process_locally"] as const) {
    const result = await evaluateSourcePolicy(
      {
        source_id: source.id,
        expected_permission_version: Number(scan.permission_version),
        lane: "policy",
        capability,
        resource: { url, document_type: source.config.policyProfile?.identity?.documentType?.value ?? null, attachment: false },
      },
      undefined,
      tx,
    );
    if (result.decision !== "allow") throw new Error(`Directory permission denied: ${capability}/${result.reason}`);
  }
}
/** Original page bytes require the still-current fulltext storage permit; thin proof remains when that use is denied. */
async function retainedBody(tx: Tx, scan: DirectoryScan, source: SourceRow, page: DirectoryFailureEvidence | DirectoryPage) {
  try {
    await lockCurrentSourcePolicies(tx, [{ sourceId: source.id, permissionVersion: Number(scan.permission_version) }]);
    await lockPolicySourceConfiguration(tx, source);
  } catch {
    return null;
  }
  const permission = await evaluateSourcePolicy(
    {
      source_id: source.id,
      expected_permission_version: Number(scan.permission_version),
      lane: "policy",
      capability: "store_fulltext",
      resource: { url: page.url, document_type: source.config.policyProfile?.identity?.documentType?.value ?? null, attachment: false },
    },
    undefined,
    tx,
  );
  return permission.decision === "allow" ? page.body : null;
}
export async function appendDirectoryPage(scan: DirectoryScan, page: DirectoryPage, source: SourceRow) {
  return sql.begin(async (tx) => {
    await lockCurrentSourcePolicies(tx, [{ sourceId: source.id, permissionVersion: Number(scan.permission_version) }]);
    await lockPolicySourceConfiguration(tx, source);
    await requireDirectoryUse(tx, scan, source, page.url);
    await lock(tx, scan.source_id);
    const [head] = await tx<DirectoryScan[]>`SELECT * FROM acquisition.directory_scans WHERE id=${scan.id} FOR UPDATE`;
    if (head?.state !== "running" || head.next_page !== page.page) throw new Error("Directory scan advanced or stopped");
    if (head.total_pages !== null && (head.total_pages !== page.totalPages || head.total_records !== page.totalRecords))
      throw new Error("Directory totals drifted");
    if (head.record_count + page.entries.length > page.totalRecords) throw new Error("Directory records exceed source total");
    const duplicates =
      await tx`SELECT record_id FROM acquisition.directory_records WHERE scan_id=${scan.id} AND record_id=ANY(${page.entries.map((e) => e.recordId)}::text[])`;
    if (duplicates.length) throw new Error("Directory record ID repeats across pages");
    await tx`INSERT INTO acquisition.directory_pages(scan_id,page_number,purpose,fetched_at,url,body_hash,body,fingerprint,evidence)
      VALUES(${scan.id},${page.page},'data',${page.fetchedAt},${page.url},${page.bodyHash},${await retainedBody(tx, scan, source, page)},${page.fingerprint},${tx.json({ totalPages: page.totalPages, totalRecords: page.totalRecords, actualCount: page.entries.length, recordIds: page.entries.map((e) => e.recordId) })})`;
    for (const entry of page.entries) {
      await tx`INSERT INTO acquisition.directory_seen(source_id,id_namespace,record_id,first_seen_at,page_scan_id)
        VALUES(${scan.source_id},${scan.contract.idNamespace},${entry.recordId},${page.fetchedAt},${scan.id}) ON CONFLICT DO NOTHING`;
      const [seen] = await tx<
        { first_seen_at: Date }[]
      >`SELECT first_seen_at FROM acquisition.directory_seen WHERE source_id=${scan.source_id} AND id_namespace=${scan.contract.idNamespace} AND record_id=${entry.recordId}`;
      // Directory metadata never stores source fulltext; acquisition of originals has its own permit and revision.
      const { bodyHtml: _html, bodyText: _text, raw: _raw, ...candidate } = entry.candidate;
      await tx`INSERT INTO acquisition.directory_records(scan_id,record_id,page_number,identity_key,document_id,role,url,metadata_hash,first_seen_at,metadata)
        VALUES(${scan.id},${entry.recordId},${page.page},${identity(scan.source_id, scan.contract, entry)},${entry.documentId},${entry.role},${entry.candidate.url},${entry.hash},${seen!.first_seen_at},${tx.json({ ...entry, candidate } as never)})`;
    }
    const [row] = await tx<
      DirectoryScan[]
    >`UPDATE acquisition.directory_scans SET next_page=next_page+1,total_pages=${page.totalPages},total_records=${page.totalRecords},
      record_count=record_count+${page.entries.length},first_fingerprint=coalesce(first_fingerprint,${page.fingerprint}) WHERE id=${scan.id} RETURNING *`;
    return row!;
  });
}
export async function failDirectoryScan(
  scan: DirectoryScan,
  reason: string,
  page: number,
  url: string,
  source: SourceRow,
  evidence?: DirectoryFailureEvidence,
) {
  await sql.begin(async (tx) => {
    const body = evidence ? await retainedBody(tx, scan, source, evidence) : null;
    await lock(tx, scan.source_id);
    const [changed] =
      await tx`UPDATE acquisition.directory_scans SET state='failed',finished_at=pg_catalog.clock_timestamp(),retry_at=pg_catalog.clock_timestamp()+interval '1 minute',reason=${reason} WHERE id=${scan.id} AND state='running' RETURNING id`;
    if (!changed) return;
    await tx`INSERT INTO acquisition.directory_pages(scan_id,page_number,purpose,fetched_at,url,body_hash,body,evidence)
      VALUES(${scan.id},${page},'failure',${evidence?.fetchedAt ?? new Date().toISOString()},${evidence?.url ?? url},${evidence?.bodyHash ?? null},${body},${tx.json({ reason, httpStatus: evidence?.httpStatus ?? null })}) ON CONFLICT DO NOTHING`;
    await receipt(tx, scan, "incomplete", { reason, page });
  });
}
export async function applyDirectoryScan(scan: DirectoryScan, probe: DirectoryPage, source: SourceRow) {
  await ensureQueue("policy.acquire", { policy: "exclusive", retryLimit: 0, expireInSeconds: 600 });
  return sql.begin(async (tx) => {
    if (source.collectionControl) await assertRuntimeControl(tx, source.collectionControl);
    await lockCurrentSourcePolicies(tx, [{ sourceId: source.id, permissionVersion: Number(scan.permission_version) }]);
    await lockPolicySourceConfiguration(tx, source);
    await requireDirectoryUse(tx, scan, source, probe.url);
    await lock(tx, source.id);
    const [current] = await tx<DirectoryScan[]>`SELECT * FROM acquisition.directory_scans WHERE id=${scan.id} FOR UPDATE`;
    if (
      current?.state !== "running" ||
      current.next_page !== current.contract.request.firstPage + current.total_pages! ||
      current.record_count !== current.total_records ||
      probe.fingerprint !== current.first_fingerprint
    )
      throw new Error("Directory round or first-page verification is inconsistent");
    const [last] = await tx<
      { fetched_at: Date }[]
    >`SELECT max(fetched_at) AS fetched_at FROM acquisition.directory_pages WHERE scan_id=${scan.id} AND purpose='data'`;
    if (Date.parse(probe.fetchedAt) < last!.fetched_at.getTime()) throw new Error("Directory verification was not fetched after the last page");
    await tx`INSERT INTO acquisition.directory_pages(scan_id,page_number,purpose,fetched_at,url,body_hash,body,fingerprint,evidence)
      VALUES(${scan.id},${probe.page},'probe',${probe.fetchedAt},${probe.url},${probe.bodyHash},${await retainedBody(tx, scan, source, probe)},${probe.fingerprint},${tx.json({ verified: true })})`;
    const previous = await tx<
      { record_id: string; identity_key: string; metadata_hash: string; material_id: string; wake_hash: string }[]
    >`SELECT r.record_id,r.identity_key,r.metadata_hash,b.material_id,b.wake_hash
      FROM acquisition.directory_heads h JOIN acquisition.directory_records r ON r.scan_id=h.scan_id JOIN acquisition.directory_bindings b ON b.scan_id=r.scan_id AND b.record_id=r.record_id
      WHERE h.source_id=${source.id}`;
    const old = new Map(previous.map((row) => [row.record_id, row]));
    const records = await tx<
      { record_id: string; identity_key: string; document_id: string | null; metadata_hash: string; first_seen_at: Date; metadata: DirectoryEntry }[]
    >`
      SELECT record_id,identity_key,document_id,metadata_hash,first_seen_at,metadata FROM acquisition.directory_records WHERE scan_id=${scan.id} AND role='current' ORDER BY record_id`;
    const dateHeads = new Map(
      (
        await materialDateIdentityHeads(
          source.id,
          records.map((r) => r.identity_key),
          tx,
        )
      ).map((row) => [row.identity_key, row]),
    );
    let created = 0,
      revised = 0,
      changed = 0;
    for (const row of records) {
      const c = row.metadata.candidate as Candidate,
        at = c.publishedAt ? new Date(String(c.publishedAt)) : null;
      const result = await upsertMaterial(
        {
          ...c,
          bodyStatus: "none",
          sourceId: source.id,
          via: "fetch",
          identityKey: row.identity_key,
          discoveredAt: row.first_seen_at,
          publishedAt: at,
          language: row.metadata.language ?? source.config.language,
          ...(c.sourceDateObservation
            ? {
                permissionVersion: Number(scan.permission_version),
                expectedSourceDateVersion: Number(dateHeads.get(row.identity_key)?.source_date_version ?? 0),
              }
            : {}),
        },
        tx,
      );
      created += Number(result.created);
      revised += Number(result.revised);
      const previous = old.get(row.record_id),
        didChange = previous?.metadata_hash !== row.metadata_hash || previous?.identity_key !== row.identity_key;
      const wakeHash = didChange ? sha256(stableJson([scan.id, row.record_id, row.metadata_hash])) : previous!.wake_hash;
      await tx`INSERT INTO acquisition.directory_bindings(scan_id,record_id,material_id,material_revision,wake_hash)
        VALUES(${scan.id},${row.record_id},${result.articleId},${result.revision},${wakeHash})`;
      if (didChange) {
        changed++;
        await enqueue(
          "policy.acquire",
          { lane: "policy", sourceId: source.id, materialId: result.articleId, directoryHash: wakeHash },
          { singletonKey: `directory:${source.id}:${result.articleId}:${wakeHash}` },
          tx,
        );
      }
    }
    const documentCount = records.every((r) => r.document_id !== null) ? new Set(records.map((r) => r.document_id)).size : null;
    await tx`UPDATE acquisition.directory_scans SET state='complete',finished_at=pg_catalog.clock_timestamp(),document_count=${documentCount} WHERE id=${scan.id}`;
    await tx`INSERT INTO acquisition.directory_heads(source_id,scan_id,applied_at) VALUES(${source.id},${scan.id},pg_catalog.clock_timestamp())
      ON CONFLICT(source_id) DO UPDATE SET scan_id=EXCLUDED.scan_id,applied_at=EXCLUDED.applied_at`;
    await receipt(tx, current, "complete", {
      totalPages: current.total_pages,
      directoryRecords: current.total_records,
      currentRecords: records.length,
      documentCount,
      firstFingerprint: current.first_fingerprint,
      probeFingerprint: probe.fingerprint,
    });
    return { created, revised, changed, records: current.total_records!, currentRecords: records.length, documentCount };
  });
}
