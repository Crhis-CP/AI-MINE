import { sql } from "../db.ts";
import { independentSelectedSources } from "./rules.ts";

/** Ordinary reports share a fact card; configured selected sources keep their own. */
export function foldableSelectionCondition() {
  return sql`(NOT p.selected OR p.source_id <> ALL(${independentSelectedSources()}::text[]))`;
}
