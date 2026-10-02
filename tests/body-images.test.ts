// Body pictures reach readers only as links to the picture on the source's site (DR-78): the item page
// and the full feed never fetch, re-host or show a source's pictures.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { linkBodyImages } from "@aihot/backend/content/sanitize";

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
  const plain = "<p>No pictures here &amp; nothing to change.</p>";
  assert.equal(linkBodyImages(plain), plain);
});

test("a linked picture does not nest links", () => {
  assert.equal(
    linkBodyImages('<p><a href="https://example.org/full.png"><img src="https://example.org/small.png" alt="Map"></a></p>'),
    `<p>${link("https://example.org/small.png", "查看配图：Map")}</p>`,
  );
  assert.equal(
    linkBodyImages('<p><a href="https://example.org/post">Read more <img src="https://example.org/arrow.png"></a></p>'),
    `<p><a href="https://example.org/post">Read more </a>${link("https://example.org/arrow.png", "查看配图")}</p>`,
  );
});

test("a picture with no address of its own is dropped, and a video loses its poster frame", () => {
  assert.equal(linkBodyImages('<p>Before <img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">after</p>'), "<p>Before after</p>");
  assert.equal(linkBodyImages('<picture><img src="https://example.org/a.png" alt="A"></picture>'), link("https://example.org/a.png", "查看配图：A"));
  assert.equal(
    linkBodyImages('<video src="https://example.org/clip.mp4" poster="https://example.org/frame.jpg" width="640"></video>'),
    '<video src="https://example.org/clip.mp4" width="640"></video>',
  );
});
