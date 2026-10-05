// Body pictures reach readers only as links to the picture on the source's site (DR-78): the item page
// and the full feed never fetch, re-host or show a source's pictures.
import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicRoleFixture, publicServer } from "./public-role-fixture.ts";
import { linkBodyImages } from "@amp/backend/content/sanitize";

const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

test("a picture becomes a link named after its description", () => {
  assert.equal(
    linkBodyImages('<p>Prices doubled.</p><p><img src="https://example.org/chart.png?a=1&amp;b=2" alt="B200  prices" width="800" height="400"></p>'),
    `<p>Prices doubled.</p><p>${link("https://example.org/chart.png?a=1&amp;b=2", "查看配图：B200 prices")}</p>`,
  );
  assert.equal(linkBodyImages('<img src="https://example.org/a.png" title="Fig. 2">'), link("https://example.org/a.png", "查看配图：Fig. 2"));
  assert.equal(
    linkBodyImages('<figure><img src="//cdn.example.org/a.png"><figcaption>Q3</figcaption></figure>'),
    `<figure>${link("https://cdn.example.org/a.png", "查看配图")}<figcaption>Q3</figcaption></figure>`,
  );
  assert.equal(
    linkBodyImages('<p><img src="https://example.org/1.png" alt="one"><img src="https://example.org/2.png" alt="two"></p>'),
    `<p>${link("https://example.org/1.png", "查看配图：one")} ${link("https://example.org/2.png", "查看配图：two")}</p>`,
  );
  const plain = "<p>No pictures here &amp; nothing to change.</p>";
  assert.equal(linkBodyImages(plain), plain);
});

test("pictures inside a link move out after it, in their order, and the link keeps its address", () => {
  const one = link("https://example.org/1.png", "查看配图：one");
  const two = link("https://example.org/2.png", "查看配图：two");
  assert.equal(
    linkBodyImages(
      '<p><a href="https://example.org/post"><img src="https://example.org/1.png" alt="one">Read more<img src="https://example.org/2.png" alt="two"></a></p>',
    ),
    `<p><a href="https://example.org/post">Read more</a> ${one} ${two}</p>`,
  );
  // Nothing of the link is left to click: it shows where it led.
  assert.equal(
    linkBodyImages(
      '<p><a href="https://example.org/report.pdf"><img src="https://example.org/1.png" alt="one"><img src="https://example.org/2.png" alt="two"></a></p>',
    ),
    `<p><a href="https://example.org/report.pdf">https://example.org/report.pdf</a> ${one} ${two}</p>`,
  );
  assert.equal(
    linkBodyImages('<p><a href="https://example.org/post">Read more <img src="https://example.org/arrow.png"></a></p>'),
    `<p><a href="https://example.org/post">Read more </a> ${link("https://example.org/arrow.png", "查看配图")}</p>`,
  );
});

test("a link that only opened its picture gives way to the picture's link", () => {
  assert.equal(
    linkBodyImages('<p><a href="https://example.org/full.png?w=2000"><img src="https://example.org/small.png" alt="Map"></a></p>'),
    `<p>${link("https://example.org/full.png?w=2000", "查看配图：Map")}</p>`,
  );
  assert.equal(
    linkBodyImages('<p><a href="https://example.org/image?id=7"><img src="https://example.org/image?id=7" alt="Mine"></a></p>'),
    `<p>${link("https://example.org/image?id=7", "查看配图：Mine")}</p>`,
  );
});

test("a picture with no web address of its own is dropped, and a video loses its poster frame", () => {
  assert.equal(linkBodyImages('<p>Before <img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">after</p>'), "<p>Before after</p>");
  assert.equal(linkBodyImages('<p>A<img src="javascript:alert(1)" alt="x">B</p>'), "<p>AB</p>");
  assert.equal(linkBodyImages('<picture><img src="https://example.org/a.png" alt="A"></picture>'), link("https://example.org/a.png", "查看配图：A"));
  assert.equal(
    linkBodyImages('<video src="https://example.org/clip.mp4" poster="https://example.org/frame.jpg" width="640"></video>'),
    '<video src="https://example.org/clip.mp4" width="640"></video>',
  );
});

test("a description is text, never markup", () => {
  assert.equal(
    linkBodyImages('<p><img src="https://example.org/q.png?a=&quot;b" alt="&quot;&gt;<b>bold</b>"></p>'),
    `<p>${link("https://example.org/q.png?a=&quot;b", '查看配图："&gt;&lt;b&gt;bold&lt;/b&gt;')}</p>`,
  );
});

test("real public_read detail and full RSS reject unproved translations and tightened full-text licences", async (t) => {
  const f = await publicRoleFixture(t),
    app = await publicServer(t, f);
  const id = "pr9-editorial-public-full";
  await f.admin`UPDATE translations SET manifest=NULL,recipe=NULL WHERE article_id=${id}`;
  const detail = async (original = false) => {
    const response = await app.request(`/api/site/items/${id}${original ? "/original" : ""}`);
    assert.equal(response.status, 200);
    return (await response.json()) as { body: { zh: string | null; original: string | null; complete: boolean } | null };
  };
  const feedItem = async () => {
    const response = await app.request("/feed/full.xml");
    assert.equal(response.status, 200);
    return (await response.text()).split("<item>").find((item) => item.includes(id))!;
  };
  const pending = await detail();
  assert.equal(pending.body!.zh, null, "replay complete=true is not model completeness evidence");
  assert.equal(pending.body!.original, null, "the default Chinese page does not substitute English");
  assert.equal(pending.body!.complete, false);
  assert.ok((await detail(true)).body!.original!.includes(`ORIGINAL_BODY_${id}`));
  assert.doesNotMatch(await feedItem(), /<content:encoded>/, "the full feed cannot substitute untranslated English");
  const provider = await stub((_hit, request) => {
    const input = JSON.parse(JSON.parse(request.body).messages[1].content) as { text: string };
    return {
      choices: [{ message: { content: JSON.stringify({ text: input.text.includes("PR9 original") ? "合成译文" : "真实假服务中文正文。" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  });
  t.after(() => provider.close());
  const script = `
    import {initializeDb,closeDb} from '@amp/backend/db';
    import {runBodyTranslation} from './packages/backend/src/editorial/translation-runtime.ts';
    import {TRANSLATION_MANIFEST_FORMAT} from './packages/backend/src/editorial/translation-readiness.ts';
    import {promptVersion,promptText} from '@amp/backend/editorial/prompts';
    await initializeDb('worker');
    try { const version=promptVersion('translate-body');
      const result=await runBodyTranslation(process.argv[1],{id:TRANSLATION_MANIFEST_FORMAT+':'+version,model:'deepseek-flash',promptVersion:version,system:promptText('translate-body')});
      if(result.status!=='translated') throw new Error(JSON.stringify(result));
    } finally {await closeDb();}
  `;
  await f.run(process.execPath, ["--input-type=module", "-e", script, id], {
    DATABASE_URL_WORKER: f.urlFor("worker"),
    DATABASE_URL_BACKUP: f.urlFor("backup"),
    MODEL_CALLS_ENABLED: "true",
    DEEPSEEK_BASE_URL: `${provider.url}/v1`,
    DEEPSEEK_API_KEY: "synthetic-fixture",
  });
  assert.equal(provider.hits(), 2, "the stored manifest came from two actual gateway/attempt writes");
  assert.ok((await detail()).body!.zh!.includes("真实假服务中文正文"));
  assert.match(await feedItem(), /真实假服务中文正文/);
  await f.admin`UPDATE sources SET syndicate_fulltext=false WHERE id='pr9-editorial'`;
  assert.doesNotMatch(await feedItem(), /<content:encoded>/, "current syndication permission overrides the cached projection");
  assert.ok((await detail()).body!.zh!.includes("真实假服务中文正文"));
  await f.admin`UPDATE sources SET site_fulltext=false WHERE id='pr9-editorial'`;
  assert.equal((await detail()).body, null);
  assert.equal((await detail(true)).body, null, "current site permission also applies to the original route");
  assert.doesNotMatch(await feedItem(), /<content:encoded>/);
});
