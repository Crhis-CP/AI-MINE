import { dbOf } from "../db.ts";
import { actorOf, audit, requireOwner, type AdminPrincipal } from "./auth.ts";
import { sourceTargetExportData } from "../sources/coverage-matrix.ts";
const sql = dbOf("identity");
export async function exportSourceTargets(principal: AdminPrincipal) {
  return sql.begin(async (db) => {
    await requireOwner(principal, db);
    const data = await sourceTargetExportData();
    await audit(actorOf(principal), "source_targets.export", "source-targets", null, null, { asOf: data.asOf, total: data.total }, undefined, db);
    return data;
  });
}
