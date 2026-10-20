import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { readSourceDateContext } from "@amp/backend/admin/sources";
import { extractFromUrl, readable } from "@amp/backend/content/extract";
import { fromHtml, fromMarkdown } from "@amp/backend/sources/web-list";
import { withSourceCrawl, CrawlDeferred } from "../packages/backend/src/acquisition/crawl.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

after(closeDb);
const body = "The mining portal provides access to production reports, project announcements and environmental documents. ".repeat(8);
const html = `<html><head><title>Member access</title></head><body><article><h1>Member access</h1><p>${body}</p><form><input name="email"><input type="password"></form></article></body></html>`;

test("HTML and Markdown listings exclude authentication links but retain news about authentication", () => {
  const base = "https://mining.invalid/news",
    source = { id: "auth-list", config: { url: base, itemSelector: "article", linkSelector: "a", titleSelector: "a" } } as never;
  const paths = ["/login", "/account/sign-up", "/oauth/authorize", "/news/auth-for-mines", "/news/production"];
  const labels = ["Member access", "Create a mining portal account", "Access mining data", "Authentication for mine systems", "Copper production update"];
  const expected = paths.slice(3).map((path) => new URL(path, base).href);
  assert.deepEqual(
    fromHtml(paths.map((path, i) => `<article><a href="${path}">${labels[i]}</a></article>`).join(""), base, source).map((row) => row.url),
    expected,
  );
  assert.deepEqual(
    fromMarkdown(paths.map((path, i) => `[${labels[i]}](${new URL(path, base).href})`).join("\n\n"), base, source).map((row) => row.url),
    expected,
  );
});

let serial = 0;
async function extracted(askedPath: string, landedPath: string) {
  const id = `auth-page-${++serial}`,
    base = `https://${id}.invalid`,
    asked = `${base}${askedPath}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config) VALUES(${id},${id},'web_list','news',true,${sql.json({ url: `${base}/news` })})`;
  await grantDateFixture(id, [base]);
  const source = (await readSourceDateContext(id))!;
  let clock = Date.parse("2030-01-01T12:00:00Z");
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await withSourceCrawl(source, id, () => extractFromUrl(asked, { allowJina: false, subject: id, lane: "news" }), {
        now: () => new Date(clock),
        get: async (url) => {
          const robots = url.endsWith("/robots.txt"),
            text = robots ? "" : html;
          return {
            status: robots ? 404 : 200,
            url: robots ? url : `${base}${landedPath}`,
            headers: new Headers({ "content-type": robots ? "text/plain" : "text/html" }),
            body: Buffer.from(text),
            text: () => text,
          };
        },
      });
    } catch (error) {
      if (!(error instanceof CrawlDeferred)) throw error;
      clock = error.retryAt.getTime() + 1;
    }
  }
  assert.fail("Synthetic source did not complete");
}

test("a redirect to a long sign-in form cannot replace an article body", async () => {
  assert.ok(readable(html, "https://mining.invalid/account/login"), "fixture passes the old body-length and readability checks");
  assert.equal(await extracted("/news/copper", "/account/login?next=%2Fnews%2Fcopper"), null);
});

test("a registry page gaining a slash and an article discussing authentication keep their body", async () => {
  assert.ok(await extracted("/mineral/register", "/mineral/register/"));
  assert.ok(await extracted("/news/auth-for-mines", "/news/auth-for-mines/"));
});
