import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRobots, robotsAllows } from "../packages/backend/src/acquisition/robots.ts";
test("specific case-insensitive groups combine, wildcard fallback stays separate, allow wins equal matches", () => {
  const r = parseRobots(
    "User-agent: *\nDisallow: /\nCrawl-delay: 20\nUser-agent: MineBot\nDisallow: /law\nCrawl-delay: 6\nUser-agent: minebot\nAllow: /law/public\nCrawl-delay: 8",
    "MineBot",
  );
  assert.equal(r.delayMs, 8000);
  assert.equal(robotsAllows(r, "https://site.invalid/home"), true);
  assert.equal(robotsAllows(r, "https://site.invalid/law/x"), false);
  assert.equal(robotsAllows(r, "https://site.invalid/law/public/a"), true);
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow: /x\nAllow: /x", "Other"), "https://site.invalid/x"), true);
});
test("anchors, wildcards, URI octets and empty disallow keep RFC matching semantics", () => {
  const r = parseRobots("User-agent: *\nDisallow:\nDisallow: /*.pdf$\nDisallow: /caf%C3%A9\nDisallow: /~law\nDisallow: /a%2Fb", "MineBot");
  for (const path of ["/x.pdf", "/caf%C3%A9", "/%7Elaw", "/a%2fb"]) assert.equal(robotsAllows(r, `https://site.invalid${path}`), false, path);
  for (const path of ["/x.pdf?view=1", "/normal", "/a/b"]) assert.equal(robotsAllows(r, `https://site.invalid${path}`), true, path);
});
test("invalid or unrepresentable crawl delays cannot become zero-delay permission", () => {
  for (const value of ["-1", "later", "999999999999999999999"]) {
    const r = parseRobots(`User-agent: *\nCrawl-delay: ${value}`, "MineBot");
    assert.equal(r.invalidDelay, true);
    assert.equal(robotsAllows(r, "https://site.invalid/"), false);
  }
  assert.equal(parseRobots("User-agent: *\nCrawl-delay: 0.5", "MineBot").delayMs, 500);
});

test("encoded literal special characters do not become wildcard operators, and long wildcard rules do not backtrack exponentially", () => {
  const r = parseRobots("User-agent: *\nDisallow: /file-%2A.html\nDisallow: /foo-%24\nDisallow: *.pdf$", "MineBot");
  assert.equal(robotsAllows(r, "https://site.invalid/file-*.html"), false);
  assert.equal(robotsAllows(r, "https://site.invalid/file-x.html"), true);
  assert.equal(robotsAllows(r, "https://site.invalid/foo-$"), false);
  assert.equal(robotsAllows(r, "https://site.invalid/a.pdf"), false);
  const long = parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(1000)}b$`, "MineBot");
  assert.equal(robotsAllows(long, `https://site.invalid/${"a".repeat(3000)}c`), true);
});
