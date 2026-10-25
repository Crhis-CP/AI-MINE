import { sql } from "../db.ts";
import { independentSelectedSources } from "./rules.ts";
import { confirmedSelected } from "./items.ts";

/** Ordinary reports share a fact card; configured selected sources keep their own. */
export function foldableSelectionCondition() {
  return sql`((${confirmedSelected()}) = false OR p.source_id <> ALL(${independentSelectedSources()}::text[]))`;
}
