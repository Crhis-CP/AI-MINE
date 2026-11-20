// Whose own text the event shadow may read (package 2, steps 2.4–2.5). A material's title and body are read only while
// its source allows processing that address locally (sources/permission-store.ts, purpose process_locally), as report
// grouping checks before it compares texts (events/report-groups.ts). Nothing the shadow derives leaves the worker; a
// report whose text may not be read simply has no fingerprint and no checked day. An unprovable permission is a "no".
import { sql, type Db } from "../../db.ts";
import { evaluateSourcePolicy, readCurrentSourcePolicy } from "../../sources/permission-store.ts";

export async function locallyReadable(materials: ReadonlyArray<{ id: string; source_id: string; url: string }>, db: Db = sql): Promise<Set<string>> {
  const versions = new Map<string, number | null>();
  const readable = new Set<string>();
  for (const m of materials) {
    if (!versions.has(m.source_id)) versions.set(m.source_id, (await readCurrentSourcePolicy(m.source_id, db).catch(() => null))?.permission_version ?? null);
    const version = versions.get(m.source_id);
    if (version === null || version === undefined) continue;
    const decision = await evaluateSourcePolicy(
      {
        source_id: m.source_id,
        lane: "news",
        capability: "process_locally",
        expected_permission_version: version,
        resource: { url: m.url, attachment: false, document_type: null },
      },
      undefined,
      db,
    );
    if (decision.decision === "allow") readable.add(m.id);
  }
  return readable;
}
