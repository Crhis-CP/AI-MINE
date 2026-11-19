// How two spellings of one name are recognised as the same. Sources write Freeport-McMoRan and Freeport McMoRan,
// Río Tinto and Rio Tinto, 自由港-麦克莫兰 and 自由港麦克莫兰; the store keeps `aliasKey(value)` beside each alias so
// equal keys are one spelling. There is no simplified/traditional conversion: such variants are aliases of their own.

const HAN = /\p{Script=Han}/u;

export const hasHan = (value: string) => HAN.test(value);

/** One Latin-script word folded for comparison: compatibility forms unified, accents dropped, lower case. */
function foldWord(word: string): string {
  return word
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * The comparison key of a spelling: NFKC, accents dropped, lower case; hyphens, dots, apostrophes and middle dots
 * become a space; runs of space become one; spaces and joiners between two Han characters disappear.
 */
export function aliasKey(value: string): string {
  return foldWord(value)
    .replace(/[-‐‑‒–—.'’·・]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(?<=\p{Script=Han})[\s\-·・]+(?=\p{Script=Han})/gu, "")
    .trim();
}

// Legal forms only. Words that describe the business (Mining, Resources, Gold, 矿业, 资源) stay: "Teck" or
// "Freeport" must be an alias of their own, with the scope that spelling deserves.
const LATIN_LEGAL_FORMS = ["inc", "corp", "corporation", "ltd", "limited", "plc", "s a", "sa", "ag", "nv", "n v", "co", "company", "group", "holdings"];
const HAN_LEGAL_FORMS = ["股份有限公司", "有限公司", "集团", "公司"];

/** `aliasKey` with trailing legal forms removed, for answering "which company is this spelling". */
export function lookupKey(value: string): string {
  let key = aliasKey(value).replace(/[,，]/g, " ").replace(/\s+/g, " ").trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const form of LATIN_LEGAL_FORMS) {
      if (key.endsWith(` ${form}`)) {
        key = key.slice(0, -form.length - 1).trim();
        changed = true;
      }
    }
    for (const form of HAN_LEGAL_FORMS) {
      // Keep at least two characters: 公司 alone is not a name.
      if (key.endsWith(form) && [...key].length - form.length >= 2) {
        key = key.slice(0, -form.length);
        changed = true;
      }
    }
  }
  return key;
}

interface Token {
  /** As written. */
  raw: string;
  key: string;
  start: number;
  end: number;
}

// Letters and digits of any script except Han: Chinese copy often writes a Latin name with no space (BHP下调).
const WORD = /(?:(?!\p{Script=Han})[\p{L}\p{N}\p{M}])+/gu;

/** The Latin-script words of a text with their offsets; punctuation, spaces and Han characters separate them. */
export function tokenize(text: string): Token[] {
  return [...text.matchAll(WORD)].map((m) => ({ raw: m[0], key: foldWord(m[0]), start: m.index, end: m.index + m[0].length }));
}
