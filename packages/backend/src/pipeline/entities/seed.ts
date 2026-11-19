// The library's first rows, built from what the code already says about companies: the tag vocabulary
// (ENTITIES, PUBLISHER_DOMAINS), the name glossary, and seed-data.ts for the rest. Those lists stay where they are,
// because they are part of prompt bytes and reader filters; the library copies them once and grows in the
// database from there.
import { NAME_GLOSSARY } from "@amp/industry/name-glossary";
import { ENTITIES, PUBLISHER_DOMAINS } from "@amp/industry/taxonomy";
import { guardedByLexicon } from "./link.ts";
import type { AliasScope, EntityOrigin, EntityRow, StatementRow } from "./model.ts";
import { aliasKey, hasHan } from "./normalize.ts";
import { ALIAS_RULES, type AliasSpec, EXTRA_ALIASES, EXTRA_COMPANIES, GLOSSARY_IDS, TICKERS } from "./seed-data.ts";

export interface SeedRows {
  entities: EntityRow[];
  statements: StatementRow[];
}

/**
 * The scope a spelling gets unless seed-data says otherwise: a Chinese name of fewer than three characters is
 * also an ordinary word (金田村, 托克逊) and needs an anchor, unless the identity lexicon guards it (力拓, 中铝).
 */
function defaultScope(entityId: string, value: string): AliasScope {
  if (!hasHan(value)) return "text";
  return [...value].length >= 3 || guardedByLexicon(entityId, value) ? "text" : "anchored";
}

export function seedRows(): SeedRows {
  const entities: EntityRow[] = [];
  const statements: StatementRow[] = [];
  const seen = new Set<string>();
  const statement = (entityId: string, property: StatementRow["property"], spec: string | AliasSpec, origin: EntityOrigin) => {
    const { value, ...given } = typeof spec === "string" ? { value: spec } : spec;
    const key = `${entityId}\u0000${property}\u0000${aliasKey(value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rule = property === "alias" ? { ...ALIAS_RULES[value], ...given } : {};
    statements.push({
      entityId,
      property,
      value,
      scope: property === "alias" ? (rule.scope ?? defaultScope(entityId, value)) : null,
      lang: null,
      caseSensitive: rule.caseSensitive ?? false,
      origin,
      status: "active",
    });
  };
  const entity = (row: Omit<EntityRow, "kind" | "status" | "mergedInto">) => entities.push({ ...row, kind: "company", status: "active", mergedInto: null });

  // The tag vocabulary: a company in the glossary is foreign and keeps its bracketed original; the others are the
  // Chinese companies, written without one.
  for (const [id, { name, aliases }] of Object.entries(ENTITIES)) {
    const glossary = NAME_GLOSSARY.find((entry) => entry.zh === name);
    const original = glossary?.en ?? aliases.find((alias) => !hasHan(alias));
    if (!original) throw new Error(`entity ${id} has no original-language name`);
    entity({ id, nameZh: name, nameOriginal: original, showOriginal: !!glossary, origin: "taxonomy" });
    for (const alias of aliases) statement(id, "alias", alias, "taxonomy");
  }
  for (const { entityId, domains } of PUBLISHER_DOMAINS) for (const domain of domains) statement(entityId, "domain", domain, "taxonomy");

  for (const { zh, en, aliases } of NAME_GLOSSARY) {
    let id = Object.entries(ENTITIES).find(([, e]) => e.name === zh)?.[0];
    if (!id) {
      id = GLOSSARY_IDS[zh];
      if (!id) throw new Error(`glossary company ${zh} has no id in seed-data.ts`);
      entity({ id, nameZh: zh, nameOriginal: en, showOriginal: true, origin: "glossary" });
    }
    for (const alias of [zh, en, ...(aliases ?? [])]) statement(id, "alias", alias, "glossary");
  }

  for (const { id, nameZh, nameOriginal, chinese, aliases } of EXTRA_COMPANIES) {
    entity({ id, nameZh, nameOriginal, showOriginal: !chinese, origin: "seed" });
    for (const alias of aliases) statement(id, "alias", alias, "seed");
  }
  for (const [id, aliases] of Object.entries(EXTRA_ALIASES)) for (const alias of aliases) statement(id, "alias", alias, "seed");
  for (const [id, symbols] of Object.entries(TICKERS)) for (const symbol of symbols) statement(id, "ticker", symbol, "seed");

  const ids = new Set(entities.map((e) => e.id));
  const stray = statements.find((s) => !ids.has(s.entityId));
  if (stray) throw new Error(`seed statement for unknown entity ${stray.entityId}`);
  return { entities, statements };
}
