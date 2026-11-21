// A film is a fixed recording, but a manual takedown still wins (AGENTS.md rule 7): each film keeps a takedown list
// beside its recording (films/<date>/redactions.json, the headlines as recorded). A listed headline leaves the page's
// data entirely, its source and time with it, and is drawn as “（该条已撤下）”. Pure: the tests call it directly.
import type { FilmData } from "../blocks/types";

export function redact(data: FilmData, takenDown: readonly string[]): FilmData {
  if (!takenDown.length) return data;
  const gone = new Set(takenDown);
  return {
    ...data,
    countries: data.countries.map((country) => ({
      ...country,
      items: country.items.map((item) =>
        gone.has(item.title) || (item.titleEn !== null && gone.has(item.titleEn)) ? { title: "", titleEn: null, source: "", at: item.at, removed: true } : item,
      ),
    })),
  };
}
