import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { beijingDate } from "@amp/contracts/time";
import { config } from "@amp/backend/config";
import { decideTimeline } from "@amp/backend/content/materials";
import { labeledPublicationInstant, readLabeledPublicationDate } from "../packages/backend/src/sources/labeled-date.ts";
import { fetchDetail } from "@amp/backend/sources/web-list";

const XINJIANG = `
<title>我国自2026年5月1日起对所有非洲建交国实施零关税</title>
<meta name="PubDate" content="2026-06-29 18:27:39"/>
<span class="date">发布日期：<b><PUBLISHTIME>2026-06-29 18:29</PUBLISHTIME></b></span>
<p>2026年2月14日，习近平主席宣布，中方将于2026年5月1日起对53个非洲建交国全面实施零关税。</p>
`;

test("a labeled publication date is kept, including its clock, and a later effective date in the body is not", () => {
  const read = readLabeledPublicationDate(XINJIANG);
  assert.deepEqual(read, { raw: "2026-06-29 18:29", localDate: "2026-06-29", hasTime: true });
  assert.equal(labeledPublicationInstant(XINJIANG)?.toISOString(), "2026-06-29T10:29:00.000Z");
});

test("a labeled date with no clock is the start of that Beijing day, not a made-up minute", () => {
  const html = "<span>发布日期：2026-06-29</span><p>自2026年5月1日起施行</p>";
  assert.equal(readLabeledPublicationDate(html)?.hasTime, false);
  assert.equal(labeledPublicationInstant(html)?.toISOString(), "2026-06-28T16:00:00.000Z");
});

test("a page that never labels a publication date is left unknown", () => {
  const html = "<p>自2026年5月1日起施行。成文日期：2026-02-14。</p>";
  assert.equal(readLabeledPublicationDate(html), null);
  assert.equal(labeledPublicationInstant(html), null);
});

test("a labeled date found months later is filed on that day, not on the morning it was collected", () => {
  const published = labeledPublicationInstant(XINJIANG);
  const found = new Date("2026-10-10T02:57:07.420Z");
  const timeline = decideTimeline(published, found);
  assert.equal(timeline.publishedAt?.toISOString(), "2026-06-29T10:29:00.000Z");
  assert.equal(timeline.timelineAt.toISOString(), timeline.publishedAt?.toISOString());
  assert.equal(beijingDate(timeline.timelineAt), "2026-06-29");
  assert.equal(beijingDate(found), "2026-10-10");
  assert.equal(timeline.backfill, true);
});

test("a detail rule that finds nothing keeps the labeled date and does not invent one from the body", async () => {
  config.allowPrivateNetworkFetch = true;
  const pages: Record<string, string> = {
    "/labeled": XINJIANG,
    "/body": "<p>自2026年5月1日起施行。成文日期：2026-02-14。</p>",
    "/kept": `<time class="pub">2026-08-01 09:00</time><span>发布日期：2026-06-29</span>`,
  };
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    res.writeHead(pages[path] ? 200 : 404, { "content-type": "text/html;charset=UTF-8" });
    res.end(pages[path] ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const source = (detail: Record<string, string>) => ({ id: "s", kind: "web_list", config: { url: `${base}/list`, detail } }) as never;
  try {
    const missed = await fetchDetail(`${base}/labeled`, source({ publishedAtSelector: ".missing" }), { date: true, title: false, summary: false });
    assert.equal(missed.sourceDateObservation?.raw, "2026-06-29 18:29");
    assert.equal(missed.publishedAt?.toISOString(), "2026-06-29T10:29:00.000Z");
    const none = await fetchDetail(`${base}/body`, source({ publishedAtSelector: ".missing" }), { date: true, title: false, summary: false });
    assert.equal(none.publishedAt, null);
    const kept = await fetchDetail(`${base}/kept`, source({ publishedAtSelector: "time.pub" }), { date: true, title: false, summary: false });
    assert.equal(kept.sourceDateObservation?.raw, "2026-08-01 09:00");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a meta publication time is used only when the page does not label one", () => {
  const html = `<meta name="PubDate" content="2026-06-29 18:27:39"><p>自2026年5月1日起</p>`;
  assert.equal(readLabeledPublicationDate(html)?.raw, "2026-06-29 18:27:39");
});
