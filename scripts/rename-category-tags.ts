// Republishes (TASK-0041) the published items whose tags still carry a category's old name: publication shows
// the new name (renameCategoryTags), but only once an item is published again. Republishing reads what is
// stored and calls no model. Tags someone set by hand are listed, not changed: a person changes them.
//   node scripts/rename-category-tags.ts            lists them, writes nothing
//   node scripts/rename-category-tags.ts --apply    republishes them, then lists what is left
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle } from "@amp/backend/publication/publish";
import { OLD_CATEGORY_TAGS } from "@amp/industry/mining-taxonomy";

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--apply");
if (unknown.length) {
  console.error(`unknown argument ${unknown.join(" ")}; nothing written (use --apply to write)`);
  process.exit(2);
}
const apply = args.includes("--apply");
await initializeDb("worker");
const sql = dbOf("publication");
interface Row {
  article_id: string;
  title: string;
  visibility: string;
  tags: string[];
  manual: boolean;
}
const old = new Set(OLD_CATEGORY_TAGS);
async function list(): Promise<Row[]> {
  const rows = await sql<Row[]>`
    SELECT p.article_id, p.title, p.visibility, p.tags, COALESCE(jsonb_typeof(o.fields->'tags') = 'array', false) AS manual
    FROM publications p LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
    WHERE p.tags && ${OLD_CATEGORY_TAGS as string[]}::text[]
    ORDER BY p.article_id`;
  for (const r of rows)
    console.log(
      [r.article_id, r.visibility, r.manual ? "人工标签" : "分析标签", r.tags.filter((t) => old.has(t)).join("、"), r.title.slice(0, 60)].join(" | "),
    );
  const manual = rows.filter((r) => r.manual).length;
  console.log(
    `${rows.length} published items carry an old category name: ${rows.length - manual} analysed, ${manual} with tags set by hand (left for a person)`,
  );
  return rows;
}
const rows = await list();
if (apply) {
  const analysed = rows.filter((r) => !r.manual);
  for (const r of analysed) await publishArticle(r.article_id);
  console.log(`republished ${analysed.length}; listing again`);
  await list();
}
await stopBoss();
await closeDb();
