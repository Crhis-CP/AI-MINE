import { sql as runtimeSql } from "@amp/backend/db";
import { completeMaterialGrouping } from "../packages/backend/src/content/grouping.ts";
/** Explicit synthetic grouping precondition for tests of translation, taxonomy or report timing. */
export async function confirmGroupingFixture(articleId: string) {
  const sql = runtimeSql;
  const [row] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id=${articleId}`;
  if (!row) throw new Error("Grouping fixture requires a material");
  await completeMaterialGrouping(articleId, row.revision, { addsValue: true, reason: "合成夹具已明确确认新增信息" }, null);
}
