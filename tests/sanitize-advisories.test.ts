import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeBody } from "@amp/backend/content/sanitize";
import * as cheerio from "cheerio";
import { policySemanticHtml } from "../modules/policy/backend/domain/semantic-html.ts";

test("news and policy sanitizers keep noscript content inert across implied-close and CDATA parser forms", () => {
  for (const sanitize of [sanitizeBody, policySemanticHtml]) {
    for (const payload of [
      '<div><noscript></div><a href="https://attacker.invalid/hidden">HIDDEN_SENTINEL</a><img src="https://attacker.invalid/beacon"></noscript>',
      '<p>Visible introduction.</p><![CDATA[ x > <noscript>]]><a href="https://attacker.invalid/hidden">HIDDEN_SENTINEL</a></noscript>',
    ]) {
      const output = sanitize(payload, "https://source.invalid/article");
      assert.doesNotMatch(output, /HIDDEN_SENTINEL|attacker\.invalid/);
    }
    const ordinary = sanitize(
      '<p>Visible qualification.</p><blockquote cite="https://source.invalid/evidence">Evidence remains conditional.</blockquote><table><tr><td rowspan="2">A</td><td>B</td></tr></table><a href="/reference">Original reference</a>',
      "https://source.invalid/article",
    );
    assert.match(ordinary, /Visible qualification/);
    assert.match(ordinary, /Evidence remains conditional/);
    assert.match(ordinary, /<table>/);
    assert.match(ordinary, /rowspan="2"/);
    assert.match(ordinary, /href="https:\/\/source.invalid\/reference"/);
    if (sanitize === sanitizeBody) assert.match(ordinary, /cite="https:\/\/source.invalid\/evidence"/);
  }
});

test("CDATA normalization preserves visible literals, attributes and normal article markup", () => {
  const input =
    "<p>Visible before.</p><code>&lt;![CDATA[ literal ]]&gt;</code>" +
    '<a href="/reference" title="<![CDATA[ literal ]]>">Original reference</a>' +
    '<blockquote cite="/evidence">Evidence remains conditional.</blockquote>' +
    '<table><tr><td rowspan="2">A</td><td>B</td></tr></table><p>Visible after.</p>';
  for (const sanitize of [sanitizeBody, policySemanticHtml]) {
    const output = sanitize(input, "https://source.invalid/article");
    const $ = cheerio.load(output);
    assert.match($.text(), /Visible before\./);
    assert.match($.text(), /Visible after\./);
    assert.equal($("code").text(), "<![CDATA[ literal ]]>");
    assert.equal($("a").attr("title"), "<![CDATA[ literal ]]>");
    assert.equal($("a").attr("href"), "https://source.invalid/reference");
    assert.equal($("blockquote").text(), "Evidence remains conditional.");
    assert.equal($("td").first().attr("rowspan"), "2");
    assert.equal($("td").last().text(), "B");
    if (sanitize === sanitizeBody) assert.equal($("blockquote").attr("cite"), "https://source.invalid/evidence");
  }
});

test("existing news and policy allowlists do not expose SVG animation or meta refresh URL sinks", () => {
  const payload =
    '<svg><a href="#safe"><svg:animate attributeName="href" values="#safe;javascript:attack()" dur=".01s"/></a></svg>' +
    '<meta http-equiv="refresh" content="0;url=data:text/html,attack">';
  for (const sanitize of [sanitizeBody, policySemanticHtml])
    assert.doesNotMatch(sanitize(payload, "https://source.invalid/article"), /javascript:|data:text|animate|<svg|<meta|attack/);
});
