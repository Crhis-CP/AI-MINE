// Model-written Chinese titles and summaries name foreign companies the reader can follow (Owner 2026-11-05):
// the common Chinese name, with the original name in brackets at its first mention, e.g. 必和必拓（BHP）.
// Names without a common Chinese name stay as written. Applied when an analysis is published, so republishing
// also fixes older copy; text set by hand is never passed here.
import { NAME_GLOSSARY, type NameEntry } from "@amp/industry/name-glossary";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A Chinese name this short is also an ordinary word (大力拓展, 金田村): only the English side triggers it. */
const SHORT_ZH = 2;

function englishPattern(entry: NameEntry) {
  // Longest spelling first so “BHP Group” wins over “BHP”; Latin word edges only.
  const spellings = [entry.en, ...(entry.aliases ?? [])].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![A-Za-z0-9-])(?:${spellings.join("|")})(?![A-Za-z0-9-])`, "g");
}

const BRACKETED = (entry: NameEntry) =>
  new RegExp(`${escapeRegExp(entry.zh)}\\s*[（(]\\s*(?:${[entry.en, ...(entry.aliases ?? [])].map(escapeRegExp).join("|")})[^）)]{0,20}[）)]`);

/** One entry applied to the text: first mention “中文（English）”, later English mentions in Chinese. */
function applyEntry(text: string, entry: NameEntry): string {
  if (BRACKETED(entry).test(text)) return text;
  const en = englishPattern(entry);
  const firstEn = text.search(en);
  const zhAt = [...entry.zh].length > SHORT_ZH ? text.indexOf(entry.zh) : -1;
  if (firstEn < 0 && zhAt < 0) return text;
  if (firstEn >= 0 && (zhAt < 0 || firstEn < zhAt)) {
    let first = true;
    return text.replace(en, (match) => {
      const out = first ? `${entry.zh}（${entry.en}）` : entry.zh;
      first = false;
      return match && out;
    });
  }
  // The Chinese name comes first: bracket the original there, and say later English mentions in Chinese.
  const head = text.slice(0, zhAt + entry.zh.length);
  const tail = text.slice(zhAt + entry.zh.length);
  if (/^\s*[（(]/.test(tail)) return text;
  return `${head}（${entry.en}）${tail.replace(en, entry.zh)}`;
}

export function bilingualNames(text: string): string {
  let out = text;
  for (const entry of NAME_GLOSSARY) out = applyEntry(out, entry);
  return out;
}
