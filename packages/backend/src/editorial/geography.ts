import { z } from "zod";
import { JURISDICTIONS } from "@amp/industry/jurisdictions";
import { sha256, stableJson } from "../lib/ids.ts";
import { promptVersion } from "./prompts.ts";
import { sql, type Db } from "../db.ts";
import { postEvidenceText, type AnalyzeInputArticle } from "./input.ts";

const codes = new Map(JURISDICTIONS.map((j) => [j.id, j]));
const text = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine((s) => s.isWellFormed() && !/[\0\uFFFD]/.test(s));
const Assignment = z.strictObject({
  code: z.string(),
  role: z.enum(["event_location", "rule_scope", "affected_location", "headquarters", "issuer_location", "background"]),
  mention: text,
  segment: z.enum(["title", "body_head", "body_tail"]),
  quote: text,
});
export const GeographyCandidate = z.strictObject({
  status: z.enum(["identified", "none", "unknown"]),
  primary: z.string().nullable(),
  assignments: z.array(z.unknown()).max(13),
  reason: text,
});
type Assignment = z.infer<typeof Assignment>;
type Material = Pick<AnalyzeInputArticle, "title" | "bodyText" | "excerpt" | "bodyStatus" | "xPost">;
const active = new Set(["event_location", "rule_scope", "affected_location"]);
export const GEOGRAPHY_DICTIONARY = JURISDICTIONS.map((j) => `${j.id}=${j.name_zh}/${j.name_en}${j.parent ? `(parent:${j.parent})` : ""}`).join("; ");
const aliases = new Map<string, Set<string>>();
for (const row of JURISDICTIONS) {
  const names = new Set([row.name_zh, row.name_en]);
  if (row.kind === "country")
    for (const locale of ["en", "zh", "es", "fr", "pt", "ru"]) names.add(new Intl.DisplayNames([locale], { type: "region" }).of(row.id)!);
  if (row.kind === "subdivision") names.add(row.name_zh.replace(/(?:省|(?:维吾尔)?自治区)$/, ""));
  if (row.kind === "organization") names.add(row.id);
  for (const name of names) aliases.set(name.toLocaleLowerCase(), new Set([...(aliases.get(name.toLocaleLowerCase()) ?? []), row.id]));
}
for (const [code, names] of Object.entries({
  US: ["US", "USA", "U.S.", "U.S.A.", "United States of America"],
  GB: ["UK", "U.K.", "Britain"],
  CN: ["中华人民共和国", "People's Republic of China"],
  CD: ["DRC", "DR Congo", "Congo-Kinshasa", "刚果民主共和国"],
}))
  for (const name of names) aliases.set(name.toLocaleLowerCase(), new Set([code]));
const digestAliases = () => sha256(stableJson([...aliases].map(([alias, ids]) => [alias, [...ids]])));
const previousAliasDigest = digestAliases();
// These unambiguous province names can support a country already chosen by the model; they never infer an event role.
for (const [code, names] of Object.entries({
  CA: ["British Columbia", "不列颠哥伦比亚省", "卑诗省"],
  AU: ["Northern Territory", "New South Wales", "北领地", "新南威尔士州"],
  AR: ["Catamarca", "Salta", "Jujuy", "卡塔马卡", "萨尔塔", "胡胡伊"],
}))
  for (const name of names) aliases.set(name.toLocaleLowerCase(), new Set([code]));
const aliasDigest = digestAliases();
const recipeForAliases = (digest: string, prompt = promptVersion("structure")) =>
  sha256(stableJson(["news-geography-v1/head12000-tail2000/adaptive-total-32000", prompt, GEOGRAPHY_DICTIONARY, digest]));
// The reviewed scope-only prompt change left geography unchanged; this exception expires with the next prompt change.
const previousStructureRecipe = promptVersion("structure") === "structure@dc56e3f181" ? recipeForAliases(previousAliasDigest, "structure@4502d2ee48") : null;
export const geographyRecipe = () => recipeForAliases(aliasDigest);
/** Only this additive vocabulary change is compatible; a different prompt, dictionary or old base still fails closed. */
export const compatibleGeographyRecipes = (recipe = geographyRecipe()) =>
  recipe === geographyRecipe() ? [recipe, recipeForAliases(previousAliasDigest)] : [recipe];
const clip = (value: string, limit: number, tail = false) => {
  const chars = Array.from(value);
  let result = "",
    bytes = 0;
  for (const c of tail ? chars.reverse() : chars) {
    const n = Buffer.byteLength(c);
    if (bytes + n > limit) break;
    result = tail ? c + result : result + c;
    bytes += n;
  }
  return result;
};
/** The same exact evidence segments are sent and validated; source name, URL and translation never count as geography evidence. */
export function geographyMaterial(a: Material, bodyBudget = 22000) {
  if (!Number.isSafeInteger(bodyBudget) || bodyBudget < 1024 || bodyBudget > 22000) throw new Error("Invalid structure evidence capacity");
  const tailBudget = Math.min(4000, Math.floor(bodyBudget / 4));
  const body = a.xPost ? postEvidenceText(a.xPost) : (a.bodyText ?? a.excerpt ?? ""),
    all = Array.from(body),
    head = clip(all.slice(0, 12000).join(""), bodyBudget - tailBudget),
    tail = all.length > Array.from(head).length ? clip(all.slice(-2000).join(""), tailBudget, true) : "";
  const overlap = Math.max(0, Array.from(head).length + Array.from(tail).length - all.length),
    actualTail = overlap ? Array.from(tail).slice(overlap).join("") : tail;
  const segments = [{ id: "title", text: a.title }, { id: "body_head", text: head }, ...(actualTail ? [{ id: "body_tail", text: actualTail }] : [])];
  return {
    bodyBudget,
    segments,
    complete: (!!a.xPost || (!!a.bodyText && a.bodyStatus === "ok")) && head + actualTail === body,
    sourceHash: sha256(stableJson([a.title, body])),
  };
}
export type NewsGeography = {
  bodyBudget: number;
  recipe: string;
  sourceHash: string;
  state: "identified" | "partial" | "none" | "unknown";
  primary: string | null;
  codes: string[];
  assignments: Assignment[];
  reason: string;
};
export function validateGeography(value: unknown, a: Material, bodyBudget = 22000): NewsGeography {
  const material = geographyMaterial(a, bodyBudget),
    base = {
      bodyBudget,
      recipe: geographyRecipe(),
      sourceHash: material.sourceHash,
      state: "unknown" as const,
      primary: null,
      codes: [] as string[],
      assignments: [] as Assignment[],
      reason: "geography_not_identified",
    },
    parsed = GeographyCandidate.safeParse(value);
  if (!parsed.success) return base;
  const assignments: Assignment[] = [],
    seen = new Set<string>();
  let rejected = false;
  for (const raw of parsed.data.assignments) {
    const parsedRow = Assignment.safeParse(raw);
    if (!parsedRow.success) {
      rejected = true;
      continue;
    }
    const row = parsedRow.data,
      source = material.segments.find((s) => s.id === row.segment)?.text,
      key = stableJson(row),
      known = aliases.get(row.mention.toLocaleLowerCase());
    let valid =
      !!codes.has(row.code) && !!source?.includes(row.quote) && row.quote.includes(row.mention) && known?.size === 1 && known.has(row.code) && !seen.has(key);
    if (/^(?:us|usa|u\.s\.|u\.s\.a\.|uk|u\.k\.|drc|un|eu|oecd)$/i.test(row.mention) && row.mention !== row.mention.toUpperCase()) valid = false;
    if (/\b(?:US|A|C)\$|\bIndian lands?\b/i.test(row.mention) || (/^(?:US|A|C)$/i.test(row.mention) && row.quote.includes(`${row.mention}$`))) valid = false;
    const at = row.quote.indexOf(row.mention),
      end = at + row.mention.length;
    if (
      /[\p{L}\p{N}]/u.test(row.mention[0] ?? "") &&
      Array.from(row.mention).every((char) => char.codePointAt(0)! < 128) &&
      (/[\p{L}\p{N}]/u.test(row.quote[at - 1] ?? "") || /[\p{L}\p{N}]/u.test(row.quote[end] ?? ""))
    )
      valid = false;
    for (const [alias, ids] of aliases)
      if (
        alias !== row.mention.toLocaleLowerCase() &&
        alias.includes(row.mention.toLocaleLowerCase()) &&
        !ids.has(row.code) &&
        row.quote.toLocaleLowerCase().includes(alias)
      )
        valid = false;
    if (!valid) {
      rejected = true;
      continue;
    }
    seen.add(key);
    assignments.push(row);
  }
  const assigned = [...new Set(assignments.filter((r) => active.has(r.role)).map((r) => r.code))];
  if (
    assigned.filter((code) => codes.get(code)?.kind === "country").length > 8 ||
    assigned.filter((code) => codes.get(code)?.kind === "subdivision").length > 5
  )
    return { ...base, reason: "geography_capacity" };
  const countries = [
    ...new Set(
      assigned
        .map((code) => codes.get(code)!)
        .map((j) => (j.kind === "country" ? j.id : j.parent))
        .filter((c): c is string => !!c),
    ),
  ];
  const primary =
    countries.length === 1
      ? countries[0]!
      : parsed.data.primary && (assigned.includes(parsed.data.primary) || countries.includes(parsed.data.primary))
        ? parsed.data.primary
        : null;
  const complete = material.complete && !rejected && parsed.data.status !== "unknown";
  const state = assigned.length
    ? complete && parsed.data.status === "identified"
      ? "identified"
      : "partial"
    : complete && parsed.data.status === "none"
      ? "none"
      : "unknown";
  return {
    ...base,
    state,
    primary: assigned.length ? primary : null,
    codes: assigned,
    assignments,
    reason: rejected ? "invalid_geography_evidence" : !material.complete ? "partial_source_material" : parsed.data.reason,
  };
}

/** Existing facts lacking explicit geography evidence are deliberately not reinterpreted by keywords. */
export async function readAnalyzedGeography(
  articleId: string,
  revision: number,
  analysisId: number | null,
  material: Material,
  db: Db = sql,
): Promise<NewsGeography> {
  if (!analysisId) return validateGeography(null, material);
  const [row] = await db<
    { output: { geography?: NewsGeography } | null }[]
  >`SELECT output FROM analyses WHERE id=${analysisId} AND article_id=${articleId} AND input_revision=${revision}`;
  const stored = row?.output?.geography,
    compatible = stored && compatibleGeographyRecipes().includes(stored.recipe);
  if (
    !stored ||
    !Number.isSafeInteger(stored.bodyBudget) ||
    stored.bodyBudget < 1024 ||
    stored.bodyBudget > 22000 ||
    (!compatible && (!previousStructureRecipe || stored.recipe !== previousStructureRecipe)) ||
    stored.sourceHash !== geographyMaterial(material).sourceHash
  )
    return validateGeography(null, material);
  const candidate = {
    status: compatible && stored.state === "none" ? "none" : compatible && stored.state === "identified" ? "identified" : "unknown",
    primary: stored.primary,
    assignments: stored.assignments,
    reason: stored.reason,
  };
  return validateGeography(candidate, material, stored.bodyBudget);
}
/** Completed compatible evidence is retained; a prior partial result can be revalidated from its received structure answer. */
export async function needsGeographyAnalysis(articleId: string, revision: number) {
  const [row] = await sql<
    { recipe: string | null; state: string | null }[]
  >`SELECT output->'geography'->>'recipe' AS recipe,output->'geography'->>'state' AS state FROM analyses WHERE article_id=${articleId} AND input_revision=${revision} ORDER BY id DESC LIMIT 1`;
  if (row?.recipe === geographyRecipe()) return false;
  return !row?.recipe || !compatibleGeographyRecipes().includes(row.recipe) || !["identified", "none"].includes(row.state ?? "");
}
