// Body pictures reach readers only as links to the picture on the source's site (DR-78): the item page
// and the full feed never fetch, re-host or show a source's pictures.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
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
