import * as cheerio from "cheerio";
import type { PolicyPart } from "./processing-plan.ts";
const address = (value: string, base?: string) => {
  try {
    const u = new URL(value, base);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
};
/** Evidence must contain the exact citation and an unambiguous official URI, either visible or its actual link attribute. */
export function explicitPolicyReference(part: PolicyPart, citation: string, officialUrl: string, quote?: string) {
  const $ = cheerio.load(part.source, null, false),
    text = part.format === "html" ? $.root().text() : part.source;
  if (!citation || (quote && !text.includes(quote)) || !(quote ?? text).includes(citation)) return false;
  const target = address(officialUrl);
  if (!target) return false;
  const urls = (quote ?? text).match(/https?:\/\/[^\s<>"']+/gu) ?? [];
  if (urls.some((u) => address(u.replace(/[.,;)，。]+$/gu, "")) === target)) return true;
  return (
    part.format === "html" &&
    $("a[href]")
      .toArray()
      .some((a) => {
        const label = $(a).text();
        return label.includes(citation) && (!quote || quote.includes(label)) && address($(a).attr("href")!, part.resourceUrl) === target;
      })
  );
}

/** Deterministic qualification version; deliberately separate from the paid model-input recipe. */
export const policyInterpretationQualityRecipe = (modelRecipe: string) => `${modelRecipe}/explicit-reference-2`;
