import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createDatabaseAccess } from "@amp/backend/db";
import { installTestConnections } from "./direct-db-fixture.ts";
import { mergeRelated, relatedNewsForPolicy } from "../packages/backend/src/publication/news-policy-links.ts";
import { looseUrlKeys, repairNewsLinks } from "../packages/backend/src/publication/news-link-index.ts";

// TASK-0567: the reports that link an official URL come from publication.news_links, not from reading every
// public article body; reports whose links are not read yet are still found, and the public state applies at once.
const access = createDatabaseAccess("test", { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: "4" }, () => {});
const db = access.dbFor("worker");
let texts: string[] = [];
const counted = new Proxy(db, {
  apply(target, self, args) {
    if (Array.isArray(args[0]) && Object.hasOwn(args[0], "raw")) texts.push((args[0] as string[]).join("?"));
    return Reflect.apply(target, self, args);
  },
});
const dispose = installTestConnections(counted);
after(async () => {
  dispose();
  await access.close();
});

const SOURCE = "news-links-source";
const OFFICIAL = "https://gov.example.invalid/decree/7";
async function report(id: string, body: string, at = new Date("2026-11-01T08:00:00Z")) {
  await db`INSERT INTO articles(id,source_id,identity_key,url,title,language,published_at,discovered_at,timeline_at,body_html,body_text,raw)
    VALUES(${id},${SOURCE},${id},${`https://news.example.invalid/${id}`},${id},'en',${at},${at},${at},${body},'text','{}')`;
  // Inserted as the migration found existing publications: the links row exists, unread.
  await db`INSERT INTO publications(article_id,title,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,visibility,eligible,selected,tags,search_text)
    VALUES(${id},${`Title ${id}`},${SOURCE},'news',${`https://news.example.invalid/${id}`},${at},${at},${at},${at},'public',true,false,${[]},${id})`;
}
const ids = async (url = OFFICIAL) => (await relatedNewsForPolicy(url)).map((row) => row.id);
async function reads(read: () => Promise<unknown>) {
  texts = [];
  const value = await read();
  return { value, text: texts.join("\n") };
}

test("policy pages find linking reports by index, and the public state and body changes count at once", async () => {
  await db`INSERT INTO sources(id,name,kind,config) VALUES(${SOURCE},'Links','rss','{}')`;
  await report("links-a", `<p>Under <a href="${OFFICIAL}#article-3">Decree 7</a> and <a href="/relative">more</a>.</p>`);
  await report("links-b", `<p>Mentions ${OFFICIAL} as text only, and <a href="https://other.example.invalid/">another site</a>.</p>`);
  await report("links-c", `<p><a href="${OFFICIAL}">Decree 7</a></p>`, new Date("2026-11-02T08:00:00Z"));
  // Rows for existing publications start unread, as the migration leaves them.
  assert.deepEqual(await db`SELECT article_id FROM publication.news_links WHERE urls IS NULL ORDER BY article_id`.then((r) => r.map((x) => x.article_id)), [
    "links-a",
    "links-b",
    "links-c",
  ]);

  // Before the backfill: the unread reports are checked in their bodies, so the answer is already complete.
  const unread = await reads(() => ids());
  assert.deepEqual(unread.value, ["links-c", "links-a"]);
  assert.ok(unread.text.includes("a.body_html LIKE"), "unread reports are checked in their bodies");

  // The backfill reads them in batches; afterwards no article body is read for a policy page.
  assert.deepEqual(await repairNewsLinks(2), { read: 3, pending: 0 });
  const stored = await db<{ article_id: string; article_revision: number; urls: string[] }[]>`
    SELECT article_id,article_revision,urls FROM publication.news_links ORDER BY article_id`;
  assert.deepEqual(
    stored.map((row) => [row.article_id, row.article_revision, row.urls]),
    [
      ["links-a", 1, [OFFICIAL]],
      ["links-b", 1, ["https://other.example.invalid/"]],
      ["links-c", 1, [OFFICIAL]],
    ],
  );
  const indexed = await reads(() => ids(`${OFFICIAL}#preamble`));
  assert.deepEqual(indexed.value, ["links-c", "links-a"]);
  assert.ok(!indexed.text.includes("body_html"), "no article body is read once every report is indexed");
  assert.ok(indexed.text.includes("l.urls @> ARRAY["), "the reports come from the links index");

  // A withdrawal, a hidden source and an unreleased pick leave at once; nothing is re-read.
  await db`UPDATE publications SET visibility='withdrawn' WHERE article_id='links-c'`;
  assert.deepEqual(await ids(), ["links-a"]);
  await db`UPDATE publications SET visibility='public',selected=true,visible_after=now()+interval '1 hour' WHERE article_id='links-c'`;
  assert.deepEqual(await ids(), ["links-a"]);
  await db`UPDATE publications SET selected=false,visible_after=NULL WHERE article_id='links-c'`;
  assert.deepEqual(await ids(), ["links-c", "links-a"]);

  // A new revision whose body drops the link: the row is unread again, so the report drops out at once, before the
  // repair (or the next publication) reads it.
  await db`UPDATE articles SET body_html='<p>No link any more.</p>',revision=revision+1 WHERE id='links-a'`;
  assert.deepEqual(await db`SELECT urls FROM publication.news_links WHERE article_id='links-a'`.then((r) => r[0]!.urls), null);
  assert.deepEqual(await ids(), ["links-c"]);
  assert.deepEqual(await repairNewsLinks(), { read: 1, pending: 0 });
  assert.deepEqual(
    await db`SELECT article_revision,urls FROM publication.news_links WHERE article_id='links-a'`.then((r) => [r[0]!.article_revision, r[0]!.urls]),
    [2, []],
  );
  // A body change that keeps the revision (presentation) is treated the same way.
  await db`UPDATE articles SET body_html=${`<p><a href="${OFFICIAL}">again</a></p>`} WHERE id='links-a'`;
  assert.deepEqual(await ids(), ["links-c", "links-a"]);
  await repairNewsLinks();
  const after = await reads(() => ids());
  assert.deepEqual(after.value, ["links-c", "links-a"]);
  assert.ok(!after.text.includes("body_html"));
  // Deleting a publication takes its links row with it.
  await db`DELETE FROM publications WHERE article_id='links-b'`;
  assert.equal((await db`SELECT 1 FROM publication.news_links WHERE article_id='links-b'`).length, 0);
});

test("a report found both by the index and among unread bodies is listed once, newest first (Codex review #355)", () => {
  const a = { id: "a", title: "A", timeline_at: new Date("2026-11-02T00:00:00Z") },
    b = { id: "b", title: "B", timeline_at: new Date("2026-11-01T00:00:00Z") };
  assert.deepEqual(mergeRelated([a, b], [a]), [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ]);
});

test("lookup keys cover case, the default port, a trailing slash and percent-encoding", () => {
  const keys = looseUrlKeys("https://gov.example.invalid/ley%201/");
  for (const stored of ["https://GOV.example.invalid:443/ley 1", "https://gov.example.invalid/ley%201", "https://gov.example.invalid/ley 1/"])
    assert.ok(keys.includes(stored.toLowerCase()), stored);
});
