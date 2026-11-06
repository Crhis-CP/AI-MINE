// Demo topic directory and topic pages for the local demo API: the real topic list (industry/topics.json) with
// synthetic counts, so the topic pages can be screenshotted without a database. Read-only, no model calls.
import { readFileSync } from "node:fs";
import path from "node:path";
import { TopicDirectory, TopicPage } from "@amp/contracts/http/public";
import { DEMO_ITEMS } from "./demo-reader.ts";

type Seed = { slug: string; name: string; group: "company" | "field" | "genre" | "project"; definition: string; related?: string[] };
const seeds = (JSON.parse(readFileSync(path.join(import.meta.dirname, "../industry/topics.json"), "utf8")) as { topics: Seed[] }).topics;
const latestAt = DEMO_ITEMS[0]?.publishedAt ?? null;
// Deterministic counts: a falling curve within each group so the size bars differ.
const summaries = seeds.map((seed, i) => {
  const recent = Math.max(0, Math.round(160 / (1 + (i % 12))) - (i % 5));
  return {
    slug: seed.slug,
    name: seed.name,
    group: seed.group,
    definition: seed.definition,
    total: recent * 9 + 12,
    recent,
    indexable: recent >= 3,
    latestAt,
    basis: seed.group === "company" ? ("all" as const) : ("selected" as const),
  };
});

export const demoTopics = TopicDirectory.parse({ topics: summaries });

export function demoTopic(slug: string) {
  const index = summaries.findIndex((t) => t.slug === slug);
  if (index < 0) return null;
  const related = (seeds[index]?.related ?? []).flatMap((s) => summaries.filter((t) => t.slug === s).map((t) => ({ slug: t.slug, name: t.name })));
  return TopicPage.parse({ topic: { ...summaries[index], related }, items: DEMO_ITEMS.slice(0, 8), page: 1, pageCount: 1 });
}
