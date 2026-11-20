/**
 * Argentine instruments' procedure, read from the official gazette text by rules (TASK-0576; no model, no network):
 * sanción by the legislature, promulgación by the executive, publication in the Boletín Oficial, and entry into force —
 * stated in the text, or else computed by the Código Civil y Comercial art. 5 default and labelled as computed. Targets of
 * “Modifícase / Sustitúyese / Derógase … Ley N° X” become relations; the cited number is always kept as text.
 */
import { foldText } from "./instrument-gate.ts";

/** Folding that keeps every character position (accents dropped, lower case, any white space one blank), so a match maps back to the original words. */
export function foldKeepingPositions(value: string) {
  let out = "";
  for (const ch of value) {
    let folded = /\s/u.test(ch)
      ? " "
      : ch
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();
    if (folded.length !== ch.length) folded = folded.slice(0, ch.length).padEnd(ch.length, " ");
    out += folded;
  }
  return out;
}

export type ArDate = { date: string; raw: string };
export type ArTarget = {
  relation: "updates" | "repeals";
  /** As readers see it: “Ley N° 24.196”, “Decreto N° 456/1997”. */
  citation: string;
  kind: ArCitedKind;
  number: string;
  year: string | null;
  /** Only some articles, an annex or a clause of the target (“Derógase el artículo 5° del Decreto …”). */
  partial: boolean;
  /** The sentence that states it (at most 200 characters). */
  quote: string;
};
export type ArCitedKind = "ley" | "decreto" | "dnu" | "resolucion" | "resolucion_conjunta" | "disposicion" | "decision_administrativa";
export type ArLifecycle = {
  sanction: ArDate | null;
  promulgation: (ArDate & { tacit: boolean }) | null;
  /** The place and date heading a decree or resolution (“Ciudad de Buenos Aires, 03/11/2026”): when it was signed. */
  signature: ArDate | null;
  publication: ArDate | null;
  vigencia: (ArDate & { basis: "stated" | "legal_default" }) | null;
  targets: ArTarget[];
};

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};
const UNITS: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  primero: 1,
  primer: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
};
const TENS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };

/** “veintiocho”, “treinta y uno”, “28” → number; words up to 99, digits as written. */
export function spanishNumber(words: string): number | null {
  const text = foldText(words).replace(/[()]/g, " ").trim();
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(/\s+(?:y\s+)?/).filter(Boolean);
  let total = 0;
  for (const part of parts) {
    if (part in UNITS) total += UNITS[part]!;
    else if (part in TENS) total += TENS[part]!;
    else return null;
  }
  return parts.length ? total : null;
}
/** “dos mil veintiséis”, “mil novecientos noventa y siete”, “2026”. */
export function spanishYear(words: string): number | null {
  const text = foldText(words).trim();
  if (/^\d{4}$/.test(text)) return Number(text);
  const match = text.match(/^(dos mil|mil novecientos)(?:\s+(.+))?$/);
  if (!match) return null;
  const rest = match[2] ? spanishNumber(match[2]) : 0;
  return rest === null ? null : (match[1] === "dos mil" ? 2000 : 1900) + rest;
}
const pad = (n: number) => String(n).padStart(2, "0");
function isoDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${pad(month)}-${pad(day)}` : null;
}
/** Calendar arithmetic on a YYYY-MM-DD date. */
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const DAY = String.raw`(\d{1,2})\s*[°º]?`;
const MONTH = `(${Object.keys(MONTHS).join("|")})`;
const YEAR = String.raw`(\d{4})`;
/** The first date in folded text: “27 de junio de 2024”, “junio 27 de 2024”, “27/06/2024”. */
function firstDate(text: string): { date: string; index: number; length: number } | null {
  const found: { date: string; index: number; length: number }[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`\b${DAY}\s+de\s+${MONTH}\s+(?:de|del)\s+(?:ano\s+)?${YEAR}`, "gu"))) {
    const date = isoDate(Number(m[3]), MONTHS[m[2]!]!, Number(m[1]));
    if (date) found.push({ date, index: m.index!, length: m[0].length });
  }
  for (const m of text.matchAll(new RegExp(String.raw`\b${MONTH}\s+${DAY}\s*,?\s+(?:de|del)\s+${YEAR}`, "gu"))) {
    const date = isoDate(Number(m[3]), MONTHS[m[1]!]!, Number(m[2]));
    if (date) found.push({ date, index: m.index!, length: m[0].length });
  }
  for (const m of text.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/gu)) {
    const date = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
    if (date) found.push({ date, index: m.index!, length: m[0].length });
  }
  found.sort((a, b) => a.index - b.index);
  return found[0] ?? null;
}
/** “a los veintiocho días del mes de octubre del año dos mil veinticuatro” (the closing formula of a law). */
function wordDate(text: string): { date: string; index: number; length: number } | null {
  const m = text.match(
    new RegExp(
      String.raw`a\s+los\s+([a-z0-9() ]{1,40}?)\s+dias?\s+del\s+mes\s+de\s+${MONTH}\s+(?:del?\s+)?(?:ano\s+)?((?:dos mil|mil novecientos)(?:\s+[a-z]+){0,4}|\d{4})`,
      "u",
    ),
  );
  if (!m) return null;
  const day = spanishNumber(m[1]!.replace(/\(\d+\)/g, "")) ?? Number(m[1]!.match(/\d+/)?.[0] ?? Number.NaN);
  let year: number | null = null,
    kept = "";
  // The year phrase may run into the next words (“… veinticuatro registrada …”): drop words until it parses.
  const words = m[3]!.split(/\s+/);
  for (let n = words.length; n > 0 && year === null; n--) {
    kept = words.slice(0, n).join(" ");
    year = spanishYear(kept);
  }
  const date = year && Number.isFinite(day) ? isoDate(year, MONTHS[m[2]!]!, day) : null;
  return date ? { date, index: m.index!, length: m[0].length - (m[3]!.length - kept.length) } : null;
}
/** The capital cities that head an instrument signed there. */
const PLACE = /\b(?:ciudad\s+(?:autonoma\s+)?de\s+buenos\s+aires|buenos\s+aires|salta|san\s+salvador\s+de\s+jujuy|rio\s+gallegos)\s*,\s*/u;
const clip = (value: string, max = 200) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);

/** The original's own words for a folded match: the same span of the source text. */
function original(source: string, _folded: string, index: number, length: number) {
  return source.slice(index, index + length).replace(/\s+/g, " ");
}

const CITED = String.raw`(ley|decreto\s+de\s+necesidad\s+y\s+urgencia|decreto|resolucion\s+conjunta|resolucion(?:\s+general)?|disposicion|decision\s+administrativa)\s+(?:n(?:ro|°|º|o)?\.?\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:\s*/\s*(\d{2,4}))?`;
const KIND: Record<string, ArCitedKind> = {
  ley: "ley",
  decreto: "decreto",
  "decreto de necesidad y urgencia": "dnu",
  resolucion: "resolucion",
  "resolucion general": "resolucion",
  "resolucion conjunta": "resolucion_conjunta",
  disposicion: "disposicion",
  "decision administrativa": "decision_administrativa",
};
const LABEL: Record<ArCitedKind, string> = {
  ley: "Ley",
  decreto: "Decreto",
  dnu: "Decreto de Necesidad y Urgencia",
  resolucion: "Resolución",
  resolucion_conjunta: "Resolución Conjunta",
  disposicion: "Disposición",
  decision_administrativa: "Decisión Administrativa",
};
/** A two-digit year as Argentine numbering writes it (“719/26”, “456/97”). */
const fullYear = (year: string | undefined) => (!year ? null : year.length === 4 ? year : Number(year) < 50 ? `20${year}` : `19${year}`);
/** Comparison key of a cited or catalogued instrument: kind, digits of the number, and the year when the numbering is per year. */
export function citationKey(text: string): { kind: ArCitedKind; number: string; year: string | null } | null {
  const m = foldText(text).match(new RegExp(CITED, "u"));
  if (!m) return null;
  const kind = KIND[m[1]!.replace(/\s+/g, " ")]!;
  return { kind, number: m[2]!.replace(/\./g, ""), year: kind === "ley" ? null : fullYear(m[3]) };
}
export function citationLabel(key: { kind: ArCitedKind; number: string; year: string | null }) {
  const number = key.kind === "ley" && key.number.length > 3 ? key.number.replace(/\B(?=(\d{3})+$)/g, ".") : key.number;
  return `${LABEL[key.kind]} N° ${number}${key.year ? `/${key.year}` : ""}`;
}

/** Instruments this text amends or repeals: the first instrument cited in each operative sentence that does so. */
export function argentineTargets(text: string): ArTarget[] {
  const folded = foldKeepingPositions(text);
  const out: ArTarget[] = [];
  const verb = /\b(modificanse|modificase|sustituyese|sustituyense|incorporase|incorporanse|reemplazase|derogase|deroganse|abrogase|abroganse)\b/gu;
  for (const m of folded.matchAll(verb)) {
    const start = m.index!;
    const sentenceEnd = folded.slice(start).search(/\.(?:\s|$)(?!\d)|;\s|\barticulo\s+\d+\s*[°º]?\s*\.?\s*-/u);
    const sentence = folded.slice(start, sentenceEnd > 0 ? start + Math.min(sentenceEnd, 400) : start + 400);
    const cited = sentence.match(new RegExp(CITED, "u"));
    if (!cited) continue;
    const key = citationKey(cited[0]);
    if (!key) continue;
    const relation = /^(?:derog|abrog)/.test(m[1]!) ? "repeals" : "updates";
    const citation = citationLabel(key);
    if (out.some((t) => t.citation === citation && t.relation === relation)) continue;
    const partial = /\b(?:articulos?|incisos?|anexos?|apartados?|parrafos?|capitulos?)\b/u.test(sentence.slice(0, cited.index));
    out.push({ relation, citation, ...key, partial, quote: clip(original(text, folded, start, sentence.length).trim()) });
  }
  return out.slice(0, 10);
}

/**
 * Procedure dates from the text. `publicationDate` is the gazette edition's date (the source's own date for the item).
 * Entry into force: an explicit clause wins; otherwise art. 5 CCyC — “las leyes rigen después del octavo día de su
 * publicación oficial” — with art. 6 counting (the publication day is excluded), so the first day in force is
 * publication + 9 days. That default is returned with basis `legal_default`, never as stated by the text.
 */
export function argentineLifecycle(input: { text: string; publicationDate: string | null }): ArLifecycle {
  const text = input.text.slice(0, 200_000);
  const folded = foldKeepingPositions(text);
  let sanction: ArDate | null = null;
  const sancionada = folded.match(/\bsancionad[ao]\s*(?:el\s+dia\s+|el\s+|en\s+fecha\s+)?[:.]?\s*/u);
  if (sancionada) {
    const after = folded.slice(sancionada.index! + sancionada[0].length, sancionada.index! + sancionada[0].length + 60);
    const date = firstDate(after);
    if (date && date.index < 5)
      sanction = { date: date.date, raw: clip(original(text, folded, sancionada.index!, sancionada[0].length + date.index + date.length)) };
  }
  if (!sanction) {
    const sala = folded.match(/\bdada\s+en\s+la\s+sala\s+de\s+sesiones[\s\S]{0,300}/u);
    const date = sala ? wordDate(sala[0]) : null;
    if (sala && date)
      sanction = {
        date: date.date,
        raw: clip(`${original(text, folded, sala.index!, 40).trim()} … ${original(text, folded, sala.index! + date.index, date.length)}`, 300),
      };
  }
  let promulgation: (ArDate & { tacit: boolean }) | null = null;
  const promulgada = folded.match(/\bpromulgad[ao]\s*(de\s+hecho)?\s*(?:el\s+dia\s+|el\s+|en\s+fecha\s+)?[:.]?\s*/u);
  if (promulgada) {
    const after = folded.slice(promulgada.index! + promulgada[0].length, promulgada.index! + promulgada[0].length + 60);
    const date = firstDate(after);
    if (date && date.index < 5)
      promulgation = {
        date: date.date,
        raw: clip(original(text, folded, promulgada.index!, promulgada[0].length + date.index + date.length)),
        tacit: !!promulgada[1],
      };
  }
  if (!promulgation) {
    // A promulgation decree printed with the law: “Ciudad de Buenos Aires, 08/07/2024 … Promúlgase la Ley N° 27.743”.
    const promulgase = folded.search(/\bpromulgase\b/u);
    if (promulgase >= 0) {
      const before = folded.slice(Math.max(0, promulgase - 1500), promulgase);
      const header = [...before.matchAll(new RegExp(PLACE.source, "gu"))].at(-1);
      const date = header ? firstDate(before.slice(header.index! + header[0].length, header.index! + header[0].length + 40)) : null;
      if (header && date && date.index < 3) {
        const at = Math.max(0, promulgase - 1500) + header.index!;
        promulgation = {
          date: date.date,
          raw: clip(`${original(text, folded, at, header[0].length + date.index + date.length)} … ${original(text, folded, promulgase, 10)}`),
          tacit: false,
        };
      }
    }
  }
  const publication = input.publicationDate ? { date: input.publicationDate, raw: input.publicationDate } : null;
  let signature: ArDate | null = null;
  const heading = folded.slice(0, 400).match(PLACE);
  if (heading) {
    const date = firstDate(folded.slice(heading.index! + heading[0].length, heading.index! + heading[0].length + 40));
    if (date && date.index < 3)
      signature = { date: date.date, raw: clip(original(text, folded, heading.index!, heading[0].length + date.index + date.length)) };
  }
  let vigencia: ArLifecycle["vigencia"] = null;
  const clause = folded.match(
    /\b(?:entrara|entraran|comenzara|comenzaran|regira|regiran|tendra|tendran|surtira|surtiran|rige|rigen)\s+(?:en\s+)?(?:vigencia|vigor|efectos?|a\s+regir)?\s*(?:a\s+partir\s+del?|desde\s+el|el\s+dia|el|a\s+los)\s+([^.;]{0,160})/u,
  );
  if (clause && publication) {
    const tail = clause[1]!;
    const raw = clip(original(text, folded, clause.index!, clause[0].length).trim(), 300);
    const days = tail.match(/^([a-z ]+?)\s*(?:\((\d+)\))?\s*dias\s+(?:habiles\s+)?(?:corridos\s+)?(?:de|a\s+partir\s+de)\s+su\s+publicacion/u);
    if (/^(?:dia\s+)?siguiente\s+al?\s+(?:de\s+)?su\s+publicacion/u.test(tail)) vigencia = { date: addDays(publication.date, 1), raw, basis: "stated" };
    else if (/^(?:(?:dia|momento|fecha)\s+(?:de\s+)?)?su\s+publicacion/u.test(tail) || /^(?:la\s+)?fecha\s+de\s+(?:su\s+)?publicacion/u.test(tail))
      vigencia = { date: publication.date, raw, basis: "stated" };
    else if (days && !/habiles/.test(tail)) {
      const n = days[2] ? Number(days[2]) : spanishNumber(days[1]!);
      if (n !== null && Number.isFinite(n)) vigencia = { date: addDays(publication.date, n), raw, basis: "stated" };
    } else {
      const date = firstDate(tail);
      if (date && date.index < 12) vigencia = { date: date.date, raw, basis: "stated" };
    }
  }
  if (!vigencia && publication) vigencia = { date: addDays(publication.date, 9), raw: publication.raw, basis: "legal_default" };
  return { sanction, promulgation, signature, publication, vigencia, targets: argentineTargets(text) };
}
