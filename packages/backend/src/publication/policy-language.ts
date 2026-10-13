export type PolicyLanguageChoice = { sourceLanguage: string; preferredSourceLanguage: string | null };
/** An existing configured preference is honoured among eligible languages; every tie uses language code, never completion time. */
export function policyLanguageOrder(rows: readonly PolicyLanguageChoice[]) {
  const key = (language: string) => language.trim().toLowerCase();
  const languages = [...new Set(rows.map((row) => row.sourceLanguage))];
  const available = new Set(languages.map(key));
  const preferred = new Set(
    rows.flatMap((row) => (row.preferredSourceLanguage && available.has(key(row.preferredSourceLanguage)) ? [key(row.preferredSourceLanguage)] : [])),
  );
  return languages.sort(
    (a, b) => Number(preferred.has(key(b))) - Number(preferred.has(key(a))) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : a > b ? 1 : 0),
  );
}
