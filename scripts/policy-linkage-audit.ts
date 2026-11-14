// Read-only public projection audit. No source acquisition, model call, repair or publication.
import { initializeDb, closeDb } from "@amp/backend/db";
import type { PolicyReadingBlock } from "@amp/contracts/http/public";
import type { z } from "zod";
import { policyCurrentPublicRecords, policyDetail, policyReading } from "../modules/policy/backend/read.ts";
import { auditPolicyLinkage } from "../modules/policy/backend/domain/linkage.ts";

if (import.meta.main) {
  if (process.argv.length > 2) throw new Error("This read-only audit accepts no apply or repair arguments");
  await initializeDb("worker");
  try {
    const rows = [];
    for (const record of await policyCurrentPublicRecords()) {
      if (!record.card.jurisdictions.some((j) => ["AR", "CN"].includes(j.code))) continue;
      try {
        const policy = await policyDetail(record.card.id),
          original = policy.expressions.find((e) => e.kind === "original" && e.reading_state === "complete");
        const blocks: z.infer<typeof PolicyReadingBlock>[] = [],
          seen = new Set<string>();
        let cursor: string | undefined, version: string | undefined;
        if (original)
          do {
            const page = await policyReading(policy.id, { expression_id: original.id, document_revision_id: original.document_revision_id, cursor, limit: 50 });
            if (version && page.content_version !== version) throw new Error("public_body_changed");
            version = page.content_version;
            blocks.push(...page.blocks);
            cursor = page.next_cursor ?? undefined;
            if (cursor && seen.has(cursor)) throw new Error("reading_cursor_did_not_advance");
            if (cursor) seen.add(cursor);
          } while (cursor);
        rows.push({ ...auditPolicyLinkage(policy, blocks), original_readable: !!original });
      } catch {
        rows.push({ id: record.card.id, status: "not_verified" });
      }
    }
    console.log(
      JSON.stringify(
        {
          scope: "current public AR/CN reading only",
          rows,
          limitations: [
            "No inference from reading permission to source acquisition; four source-body categories require the independent qualification contract.",
            "Public omissions and private verifier rejections are not reconstructible here; blocked_claims=null, never zero.",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDb();
  }
}
