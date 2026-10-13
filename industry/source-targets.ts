import data from "./source-targets.json" with { type: "json" };
// Owner's original identity fields only. Historical runtime/configuration observations are not projected.
export const SOURCE_TARGETS = Object.freeze(data.targets.map((target) => Object.freeze(target)));
export const SOURCE_RECORDS = Object.freeze(data.records.map((record) => Object.freeze(record)));
