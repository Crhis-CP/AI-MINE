import assert from "node:assert/strict";
import test from "node:test";
import { readingBlock } from "../packages/backend/src/publication/policies-project.ts";
import { policySemanticHtml } from "../packages/backend/src/policy/semantic-html.ts";

test("published legal blocks preserve deleted provisions, superscripts, ordered lists and merged cells", () => {
  const html =
    '<p><del>shall pay 10</del> shall pay 20 m<sup>2</sup></p><ol start="3"><li>First obligation</li><li value="7">Second exception</li></ol><table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>';
  const block = readingBlock("public-block", html, "html", "https://official.invalid/law", []);
  assert.match(block.semantic_html!, /<del>shall pay 10<\/del>/);
  assert.match(block.semantic_html!, /<sup>2<\/sup>/);
  assert.match(block.semantic_html!, /<ol start="3">/);
  assert.match(block.semantic_html!, /<li value="7">/);
  assert.match(block.semantic_html!, /rowspan="2"/);
});
test("public legal HTML removes executable attributes, styles and embedded content", () => {
  const html = policySemanticHtml(
    '<p onclick="attack()" style="display:none">Rule<script>attack()</script><a href="javascript:attack()">bad</a><img src="https://other.invalid/tracker" /><a href="/law#clause">good</a></p>',
    "https://official.invalid/law",
  );
  assert.doesNotMatch(html, /onclick|style=|javascript:|script|<img|attack/);
  assert.match(html, /href="https:\/\/official.invalid\/law#clause"/);
  assert.match(html, /noopener noreferrer/);
});
