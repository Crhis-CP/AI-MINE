import { identitySql as sql } from "@amp/backend/db";
import { actorOf, audit, requireOwner, type AdminPrincipal } from "@amp/backend/admin/auth";
import { sourceTargetExportData } from "./coverage.ts";

export async function exportSourceTargets(principal: AdminPrincipal) {
  return sql.begin(async (db) => {
    await requireOwner(principal, db);
    const data = await sourceTargetExportData();
    await audit(actorOf(principal), "source_targets.export", "source-targets", null, null, { asOf: data.asOf, total: data.total }, undefined, db);
    return data;
  });
}
