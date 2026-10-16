import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { CATEGORY_KEYS } from "@amp/contracts/taxonomy";
import { buildApp } from "./site-app.ts";
const sql = dbOf("publication");
const app = await buildApp("public-api");
after(async () => {
  await app.close();
  await closeDb();
});
const source = `rss-r2-${tag()}`,
  id = `${source}-item`;
const category = CATEGORY_KEYS[0];
test("every RSS item preserves publisher attribution and AI labels while full text stays permission gated", async () => {
  await sql`INSERT INTO sources(id,name,kind,participation_mode,site_fulltext,syndicate_fulltext) VALUES(${source},'原始发布方','rss','editorial',true,true)`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,language,body_status,body_html,body_text,raw,discovered_at,timeline_at)
    VALUES(${id},${source},${id},'https://example.invalid/original','合成报道','zh','ok','<p>许可内全文</p>','许可内全文','{}',now(),now())`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,visibility,eligible,selected,seat,visible_after,category,body_mode,syndicate)
    VALUES(${id},'合成报道','合成导读',${source},'news','https://example.invalid/original',now(),now(),now(),now(),'public',true,true,true,now(),${category},'full',true)`;
  for (const route of ["/feed.xml", "/feed/all.xml", "/feed/full.xml", `/feed/category/${category}.xml`, `/feed/full/category/${category}.xml`]) {
    const res = await app.inject(route);
    assert.equal(res.statusCode, 200, route);
    assert.match(res.body, /<description><!\[CDATA\[<p>据<a href="https:\/\/example.invalid\/original">原始发布方<\/a>原文整理：合成导读/);
    assert.match(res.body, /AI 辅助生成或翻译/);
    assert.match(res.body, /<category domain="ai-label">ai_generated<\/category>/);
    assert.match(res.body, /<amp:content-id>/);
    assert.equal(res.headers["cache-control"], "public, max-age=0, s-maxage=0, must-revalidate");
    assert.match(res.body, /<ttl>1<\/ttl>/);
    if (route.includes("/full")) assert.match(res.body, /<content:encoded>/);
    else assert.doesNotMatch(res.body, /<content:encoded>/);
  }
  await sql`INSERT INTO publication.manual_copies(article_id,material_revision,body_html,label,state) VALUES(${id},1,'<p>人工修订正文</p>','AI辅助整理并经人工修订','active')`;
  assert.match((await app.inject("/feed.xml")).body, /ai_assisted_human_edited/);
  await sql`UPDATE sources SET syndicate_fulltext=false WHERE id=${source}`;
  assert.doesNotMatch((await app.inject("/feed/full.xml")).body, /<content:encoded>/);
});
test("RSS revalidation removes a withdrawn flash from all synthesized daily prose and changes the ETag", async () => {
  const content = {
    lead: { title: "必须消失的旧标题", leadParagraph: "必须消失的旧导语" },
    sections: [],
    flashes: [{ itemId: id, publicationRevision: 1, title: "引用标题" }],
  };
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('daily','2099-10-12',now(),now(),${sql.json(content)},now())`;
  const first = await app.inject("/feed/daily.xml");
  assert.match(first.body, /必须消失的旧导语/);
  assert.match(first.body, /AI 辅助生成\/翻译/);
  const same = await app.inject({ url: "/feed/daily.xml", headers: { "if-none-match": String(first.headers.etag) } });
  assert.equal(same.statusCode, 304);
  assert.equal(same.headers["cache-control"], "public, max-age=0, s-maxage=0, must-revalidate");
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
  const changed = await app.inject({ url: "/feed/daily.xml", headers: { "if-none-match": String(first.headers.etag) } });
  assert.equal(changed.statusCode, 200);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.doesNotMatch(changed.body, /必须消失的旧导语|必须消失的旧标题|引用标题/);
  assert.match(changed.body, /2099-10-12/);
  assert.doesNotMatch((await app.inject("/feed.xml")).body, /合成导读/);
});
