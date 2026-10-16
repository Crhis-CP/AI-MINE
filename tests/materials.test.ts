// Material storage: every distinct change gets its own revision and history row, also under
// concurrency; imported history gets a baseline instead of a revision; simultaneous first reports
// of one URL create one article; other sources' listings, returns to an earlier version and characters
// lost in transit are no revision (articles used to flip between two versions on
// every fetch, and a feed garbled a few characters differently on every load).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { identityKeyForUrl } from "@amp/backend/lib/url";

const SOURCE = `test-materials-${tag()}`;
const OTHER = `test-materials-other-${tag()}`;
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test materials', 'rss', '2100-01-01'),
            (${OTHER}, 'Test aggregator', 'rss', '2100-01-01')`;
});
after(() => closeDb());

const state = async (id: string) =>
  (
    await sql<{ revision: number; title: string; content_hash: string | null; processing_state: string }[]>`
    SELECT revision, title, content_hash, processing_state FROM articles WHERE id = ${id}`
  )[0]!;

/** An article as a history import writes it: imported content, no hash, no history row, analysed. */
async function imported(url: string) {
  const id = `imp${tag()}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, revision, content_hash, body_text, body_status, processing_state)
            VALUES (${id}, ${SOURCE}, ${identityKeyForUrl(url)}, ${url}, 'Legacy title', now(), now(), 1, NULL, 'legacy body', 'ok', 'analyzed')`;
  return id;
}

test("concurrent changes to one article each get a revision", async () => {
  const url = `https://example.com/race-${tag()}`;
  const first = await upsertMaterial({ sourceId: SOURCE, url, title: "T0", excerpt: "e0", via: "fetch" });
  const results = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((i) => upsertMaterial({ sourceId: SOURCE, url, title: `T${i}`, excerpt: `distinct excerpt ${i}`, via: "fetch" })),
  );
  assert.ok(results.every((r) => r.articleId === first.articleId && r.revised));
  const [article] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${first.articleId}`;
  const history = await sql<{ revision: number }[]>`SELECT revision FROM article_revisions WHERE article_id = ${first.articleId} ORDER BY revision`;
  assert.equal(article!.revision, 7);
  assert.deepEqual(
    history.map((h) => h.revision),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test("an unchanged report does not add a revision", async () => {
  const url = `https://example.com/same-${tag()}`;
  const first = await upsertMaterial({ sourceId: SOURCE, url, title: "Same", excerpt: "same", via: "fetch" });
  const again = await upsertMaterial({ sourceId: SOURCE, url, title: "Same", excerpt: "same", via: "fetch" });
  assert.equal(again.revised, false);
  const [article] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${first.articleId}`;
  assert.equal(article!.revision, 1);
});

test("an imported article's first report records a baseline, not a revision", async () => {
  const url = `https://example.com/imported-${tag()}`;
  const id = `imp${tag()}`;
  // What a history import writes: imported content, no hash, already analysed.
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, revision, content_hash, body_text, body_status, processing_state)
            VALUES (${id}, ${SOURCE}, ${identityKeyForUrl(url)}, ${url}, 'Legacy  title', now(), now(), 1, NULL, 'legacy body', 'ok', 'analyzed')`;
  const listed = { sourceId: SOURCE, url, title: "Legacy title", excerpt: "feed summary", via: "fetch" as const };
  const first = await upsertMaterial(listed);
  assert.deepEqual([first.articleId, first.revised, first.created], [id, false, false]);
  assert.equal((await upsertMaterial(listed)).revised, false, "the baseline holds");
  const changed = await upsertMaterial({ ...listed, title: "Legacy title, corrected" });
  assert.equal(changed.revised, true, "a real change after the baseline is a revision");
  const [article] = await sql<{ revision: number; processing_state: string }[]>`SELECT revision, processing_state FROM articles WHERE id = ${id}`;
  assert.deepEqual([article!.revision, article!.processing_state], [2, "new"]);
});

test("simultaneous first reports of one URL create one article", async () => {
  const url = `https://example.com/new-${tag()}`;
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => upsertMaterial({ sourceId: SOURCE, url, title: "New", excerpt: "new", via: "fetch" })));
  assert.equal(new Set(results.map((r) => r.articleId)).size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
});

test("same URL stays independent for each source and lane", async () => {
  const url = `https://example.com/listed-twice-${tag()}`;
  await sql`UPDATE sources SET lane='policy' WHERE id=${OTHER}`;
  const own = await upsertMaterial({ sourceId: SOURCE, url, title: "Original", bodyText: "news body", via: "fetch" });
  const mirror = await upsertMaterial({ sourceId: OTHER, url, title: "Policy", bodyText: "policy body", via: "fetch" });
  assert.notEqual(mirror.articleId, own.articleId);
  assert.equal(mirror.created, true);
  assert.equal((await upsertMaterial({ sourceId: OTHER, url, title: "Policy", bodyText: "policy body", via: "fetch" })).created, false);
  assert.equal((await state(own.articleId)).title, "Original");
  assert.equal((await state(mirror.articleId)).title, "Policy");
});

test("an article linking to a tweet is stored separately from the tweet", async () => {
  const tweetId = `${Date.now()}123456`;
  const url = `https://x.com/openai/status/${tweetId}`;
  const tweet = await upsertMaterial({ sourceId: SOURCE, url, title: "Original tweet", via: "fetch" });
  const article = await upsertMaterial({
    sourceId: OTHER,
    url: `https://example.com/report-${tag()}?related=${url}`,
    title: "Independent report",
    via: "fetch",
  });
  assert.equal(article.created, true);
  assert.notEqual(article.articleId, tweet.articleId);
  assert.equal((await state(tweet.articleId)).title, "Original tweet");
  assert.equal((await state(article.articleId)).title, "Independent report");
  const alias = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://twitter.com/openai/status/${tweetId}`,
    title: "Tweet alias",
    via: "fetch",
  });
  assert.equal(alias.created, false);
  assert.equal(alias.articleId, tweet.articleId);
});

test("another source reporting an imported article first does not set its baseline", async () => {
  const url = `https://example.com/imported-mirror-${tag()}`;
  const id = await imported(url);
  const mirror = await upsertMaterial({ sourceId: OTHER, url, title: "镜像站的标题", excerpt: "镜像摘要", via: "fetch" });
  assert.notEqual(mirror.articleId, id);
  assert.equal(mirror.created, true);
  assert.equal((await state(id)).content_hash, null, "the mirror's version is not the baseline");
  const own = await upsertMaterial({ sourceId: SOURCE, url, title: "Legacy title", excerpt: "feed summary", via: "fetch" });
  assert.equal(own.revised, false, "the article's own listing records the baseline");
  assert.deepEqual([(await state(id)).revision, (await state(id)).processing_state], [1, "analyzed"]);
});

test("returning to an earlier source text creates a new current revision", async () => {
  const url = `https://example.com/reverted-${tag()}`;
  const a = { sourceId: SOURCE, url, title: "A", bodyText: "original material", via: "fetch" as const };
  const first = await upsertMaterial(a);
  await upsertMaterial({ ...a, title: "B", bodyText: "corrected material" });
  const reverted = await upsertMaterial(a);
  assert.equal(reverted.revised, true);
  assert.deepEqual([(await state(first.articleId)).revision, (await state(first.articleId)).title], [3, "A"]);
  assert.equal((await upsertMaterial(a)).revised, false);
});

test("an imported article returning to its baseline receives a new revision", async () => {
  // A page that rotates promotions: the baseline, another rendering, then the baseline again.
  const url = `https://example.com/rotating-${tag()}`;
  const id = await imported(url);
  const base = { sourceId: SOURCE, url, title: "Legacy title", bodyText: "Post text. PODCAST SERIES Ideas", via: "fetch" as const };
  assert.equal((await upsertMaterial(base)).revised, false, "baseline");
  assert.equal((await upsertMaterial({ ...base, bodyText: "Post text. Foundry Labs" })).revised, true);
  assert.equal((await upsertMaterial(base)).revised, true, "the source restored its earlier version");
  assert.equal((await state(id)).revision, 3);
});

test("characters lost in transit are no revision, lost or restored", async () => {
  // A feed that garbles a few characters at random on every load: the 盖 of 覆盖 arrives as two U+FFFD, a ， as three.
  const url = `https://example.com/garbled-${tag()}`;
  const excerpt = "新旗舰店覆盖的产品范围更广，包括内衣、家居服、运动服饰、香水及身体护理。";
  const clean = { sourceId: SOURCE, url, title: "维密重回上海淮海路，中国市场进入扩店阶段", excerpt, via: "fetch" as const };
  const lost = (s: string, from: string, n: number) => s.replace(from, "\uFFFD".repeat(n));
  const garbled = [
    { ...clean, excerpt: lost(excerpt, "盖", 2) },
    { ...clean, excerpt: lost(excerpt, "，", 3) },
    { ...clean, title: lost(clean.title, "淮", 2), excerpt: lost(excerpt, "衣", 1) },
  ];
  const first = await upsertMaterial(garbled[0]!);
  for (const report of [clean, ...garbled, clean]) assert.equal((await upsertMaterial(report)).revised, false);
  assert.equal((await state(first.articleId)).revision, 1);
  const edited = (r: typeof clean) => ({ ...r, excerpt: r.excerpt.replace("香水", "美妆") });
  assert.equal((await upsertMaterial(edited(garbled[1]!))).revised, true, "a real change is one, lost characters or not");
  for (const report of [edited(clean), edited(garbled[2]!)]) assert.equal((await upsertMaterial(report)).revised, false);
  assert.equal((await state(first.articleId)).revision, 2);
});

test("explicit fragment-preserving URL identities remain source-scoped", async () => {
  const url = `https://example.com/changelog-${tag()}#entry`;
  const identityKey = identityKeyForUrl(url, { keepFragment: true })!;
  const a = await upsertMaterial({ sourceId: SOURCE, url, identityKey, title: "A", via: "fetch" });
  const b = await upsertMaterial({ sourceId: OTHER, url, identityKey, title: "B", via: "fetch" });
  assert.notEqual(a.articleId, b.articleId);
  assert.equal((await upsertMaterial({ sourceId: SOURCE, url, identityKey, title: "A", via: "fetch" })).created, false);
});

test("material insertion rolls back when a later discovery write fails through the injected database proxy", async () => {
  const url = `https://example.com/rollback-${tag()}`;
  await sql.unsafe(
    `CREATE FUNCTION fail_material_discovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic discovery failure'; END $$`,
  );
  await sql.unsafe(`CREATE TRIGGER fail_material_discovery BEFORE INSERT ON article_discoveries FOR EACH ROW EXECUTE FUNCTION fail_material_discovery()`);
  try {
    await assert.rejects(() => upsertMaterial({ sourceId: SOURCE, url, title: "Rollback", via: "fetch" }), /synthetic discovery failure/);
    assert.equal((await sql`SELECT id FROM articles WHERE url=${url}`).length, 0);
  } finally {
    await sql.unsafe(`DROP TRIGGER fail_material_discovery ON article_discoveries`);
  }
});
