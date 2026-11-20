// core/catalogue.ts: whether an archived policy original's attachment list is closed (plan 2.13). The decision table
// first, then the synthetic fixtures read the way the new write side will read them. Not wired into the legacy
// acquisition, so no archived manifest and no public edition changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as cheerio from "cheerio";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { type CatalogueFacts, catalogueState } from "../modules/policy/backend/core/catalogue.ts";

const page = (facts: Partial<CatalogueFacts>): CatalogueFacts => ({
  original: "page",
  embeddedFiles: 0,
  attachmentSelector: null,
  linkedLabels: null,
  bodyAnnexLabels: [],
  ...facts,
});

test("a page from a source that declares no attachment list closes when its body names no annex, and stays open when it names one", () => {
  assert.deepEqual(catalogueState(page({})), { closed: true, basis: "no_attachments_declared" });
  assert.deepEqual(catalogueState(page({ bodyAnnexLabels: ["附件1"] })), { closed: false, reason: "body_names_unlisted_annex" });
  // Without a selector the links are not read, so a list passed anyway does not close it.
  assert.deepEqual(catalogueState(page({ bodyAnnexLabels: ["附件1"], linkedLabels: ["附件1"] })), {
    closed: false,
    reason: "body_names_unlisted_annex",
  });
});

test("a page with a declared list closes when every annex its body names is listed (today's rule, kept)", () => {
  const listed = (bodyAnnexLabels: string[], linkedLabels: string[] | null) =>
    catalogueState(page({ attachmentSelector: "a[data-annex]", bodyAnnexLabels, linkedLabels }));
  // The legacy extraction test's case: the body names Attachment 1, the list links Attachment 2, then Attachment 1.
  assert.deepEqual(listed(["Attachment 1"], ["Attachment 2"]), { closed: false, reason: "body_names_unlisted_annex" });
  assert.deepEqual(listed(["Attachment 1"], ["Attachment 1"]), { closed: true, basis: "all_links_listed" });
  assert.deepEqual(listed([], []), { closed: true, basis: "all_links_listed" });
  assert.deepEqual(listed([], ["Anexo I", "Anexo II"]), { closed: true, basis: "all_links_listed" });
  assert.deepEqual(listed(["Anexo I", "Anexo II"], ["Anexo II"]), { closed: false, reason: "body_names_unlisted_annex" });
  assert.deepEqual(listed(["Anexo I"], null), { closed: false, reason: "list_unreadable" });
  assert.deepEqual(listed([], null), { closed: false, reason: "list_unreadable" });
});

test("labels compare after compatibility folding, white space and case; a link without text names nothing", () => {
  const listed = (bodyAnnexLabels: string[], linkedLabels: string[]) =>
    catalogueState(page({ attachmentSelector: "ul a", bodyAnnexLabels, linkedLabels })).closed;
  assert.equal(listed(["附件１"], ["附件1"]), true);
  assert.equal(listed(["附件Ⅱ"], ["附件II"]), true);
  assert.equal(listed(["ANEXO  I"], [" anexo i "]), true);
  assert.equal(listed(["Annex\nA"], ["annex a"]), true);
  assert.equal(listed(["附件1"], ["附件 1"]), false);
  assert.equal(listed(["Anexo I"], ["Anexo II"]), false);
  assert.equal(listed([], ["", "  "]), true);
  assert.throws(() => catalogueState(page({ attachmentSelector: "ul a", bodyAnnexLabels: [" "], linkedLabels: [] })), RangeError);
  assert.throws(() => catalogueState(page({ bodyAnnexLabels: [""] })), RangeError);
});

test("a PDF original closes when it embeds no file; a missing original or an unreadable body leaves the list open", () => {
  assert.deepEqual(catalogueState(page({ original: "pdf" })), { closed: true, basis: "pdf_without_embedded_files" });
  assert.deepEqual(catalogueState(page({ original: "pdf", embeddedFiles: 2 })), { closed: false, reason: "pdf_embeds_files" });
  // The selector and labels of a page do not apply to a PDF.
  assert.deepEqual(catalogueState(page({ original: "pdf", attachmentSelector: "a", linkedLabels: null, bodyAnnexLabels: null })), {
    closed: true,
    basis: "pdf_without_embedded_files",
  });
  // A missing original stays open even where the other facts would close the list.
  for (const facts of [
    page({ original: "missing" }),
    page({ original: "missing", attachmentSelector: "a", linkedLabels: ["附件1"], bodyAnnexLabels: ["附件1"] }),
  ])
    assert.deepEqual(catalogueState(facts), { closed: false, reason: "original_missing" });
  for (const attachmentSelector of [null, "a[data-annex]"])
    assert.deepEqual(catalogueState(page({ attachmentSelector, linkedLabels: [], bodyAnnexLabels: null })), { closed: false, reason: "body_unreadable" });
  for (const embeddedFiles of [-1, 1.5, Number.NaN]) assert.throws(() => catalogueState(page({ original: "pdf", embeddedFiles })), RangeError);
});

/** Annex labels the way a source's reviewed reference pattern finds them (the legacy acquisition's rule). */
const REFERENCE = "(附件\\s*[0-9０-９]+)";
const labels = (text: string) => [...text.matchAll(new RegExp(REFERENCE, "gu"))].map((match) => match[1]!);
function htmlFacts(html: string, attachmentSelector: string | null): CatalogueFacts {
  const $ = cheerio.load(html);
  const body = $("div.article");
  return {
    original: "page",
    embeddedFiles: 0,
    attachmentSelector,
    linkedLabels: attachmentSelector
      ? labels(
          $(attachmentSelector)
            .map((_, element) => $(element).text())
            .get()
            .join("\n"),
        )
      : null,
    bodyAnnexLabels: body.length === 1 ? labels(body.text()) : null,
  };
}

test("fixture: a page whose body names 附件1 and 附件２ but links only 附件2 stays open until 附件1 is linked", () => {
  const html = readFileSync(new URL("./fixtures/policy/annex-unlisted.html", import.meta.url), "utf8");
  assert.deepEqual(htmlFacts(html, null).bodyAnnexLabels, ["附件1", "附件２"]);
  assert.deepEqual(catalogueState(htmlFacts(html, null)), { closed: false, reason: "body_names_unlisted_annex" });
  assert.deepEqual(catalogueState(htmlFacts(html, "ul.attachments a")), { closed: false, reason: "body_names_unlisted_annex" });
  // Link 附件1 as well: the full-width 附件２ of the body matches the link 附件2.
  const linked = html.replace("</ul>", '<li><a href="/files/annex-1.pdf">附件1 示例办法</a></li>\n</ul>');
  assert.deepEqual(catalogueState(htmlFacts(linked, "ul.attachments a")), { closed: true, basis: "all_links_listed" });
  // A body that names no annex at all closes even though the source declares no list.
  const plain = html.replace("办法正文见附件1，申请表见附件２。", "").replace("<p>附件：1. 示例办法</p>\n<p>2. 申请表</p>\n", "");
  assert.doesNotMatch(cheerio.load(plain)("div.article").text(), /附件/);
  assert.deepEqual(catalogueState(htmlFacts(plain, null)), { closed: true, basis: "no_attachments_declared" });
  // A body selector that does not match leaves the list open.
  assert.deepEqual(catalogueState(htmlFacts(html.replace('class="article"', 'class="content"'), null)), { closed: false, reason: "body_unreadable" });
});

/**
 * Files a PDF embeds. pdfjs 6 returns a Map from getAttachments (null when there is none): Object.keys on it sees
 * nothing, so the count comes from its size.
 */
async function embeddedFiles(name: string) {
  const task = getDocument({ data: new Uint8Array(readFileSync(new URL(`./fixtures/policy/${name}`, import.meta.url))), stopAtErrors: true, verbosity: 0 });
  try {
    const attachments: unknown = await (await task.promise).getAttachments();
    return attachments instanceof Map ? attachments.size : Object.keys(attachments ?? {}).length;
  } finally {
    await task.destroy();
  }
}

test("fixture: a PDF that embeds a file stays open; a PDF without one closes", async () => {
  assert.equal(await embeddedFiles("embedded-file.pdf"), 1);
  assert.deepEqual(catalogueState(page({ original: "pdf", embeddedFiles: await embeddedFiles("embedded-file.pdf") })), {
    closed: false,
    reason: "pdf_embeds_files",
  });
  assert.equal(await embeddedFiles("text.pdf"), 0);
  assert.deepEqual(catalogueState(page({ original: "pdf", embeddedFiles: await embeddedFiles("text.pdf") })), {
    closed: true,
    basis: "pdf_without_embedded_files",
  });
});
