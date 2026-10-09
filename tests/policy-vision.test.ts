import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { after, beforeEach, test } from "node:test";
import sharp from "sharp";
import { dbOf, initializeDb, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { invalidateModelCache } from "../packages/backend/src/editorial/models.ts";
import { recordPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import { runPolicyVision, loadPolicyVision, loadPolicyVisionProof } from "../packages/backend/src/policy/vision-runtime.ts";
import { extractPolicyOriginal } from "../packages/backend/src/policy/extraction.ts";
import { runPolicyFulltext, setPolicyProcessingPaused } from "../packages/backend/src/policy/fulltext-runtime.ts";
import { readPolicyFulltextRun } from "../packages/backend/src/policy/fulltext-store.ts";
import { checkVisionPage, checkVisionVerification, VisionPageReply } from "../packages/backend/src/policy/vision-schema.ts";
import { renderPolicyPdf } from "../packages/backend/src/policy/vision-render.ts";
import { sha256, stableJson } from "../packages/backend/src/lib/ids.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("policy"),
  root = await initializeDb("test"),
  profile = { bodySelector: null, attachmentSelector: null, maxBytes: 2_000_000, maxResources: 8, maxPages: 20, maxTextBytes: 2_000_000 };
type Json = ReturnType<typeof JSON.parse>;
const sent: { input: Json; body: Json; raw: string }[] = [];
let mode = "pass",
  usage: { prompt_tokens: number; completion_tokens: number } | null = { prompt_tokens: 100, completion_tokens: 50 },
  hook = async (_input: Json) => {};
function extract(input: Json) {
  const page = input.pages.find((p: Json) => p.locationId === input.target_location_id),
    table = page.textItems.some((i: Json) => i.text === "Metal");
  const blocks = table
    ? [
        {
          id: "table",
          kind: "table",
          bbox: [0, 0, 1, 1],
          text: "",
          text_item_ids: page.textItems.map((i: Json) => i.id),
          rows: 2,
          cols: 2,
          cells: page.textItems.map((i: Json, n: number) => ({
            row: Math.floor(n / 2),
            col: n % 2,
            rowspan: 1,
            colspan: 1,
            header: n < 2,
            text: i.text,
            bbox: [(n % 2) * 0.5, Math.floor(n / 2) * 0.5, (n % 2) * 0.5 + 0.5, Math.floor(n / 2) * 0.5 + 0.5],
          })),
          continues_from_previous: page.page === 2,
          continues_on_next: page.page === 1,
        },
      ]
    : page.textItems.length
      ? page.textItems.map((i: Json, n: number) => ({
          id: `b${n}`,
          kind: "paragraph",
          bbox: [0, 0, 1, 1],
          text: i.text,
          text_item_ids: [i.id],
          rows: 0,
          cols: 0,
          cells: [],
          continues_from_previous: false,
          continues_on_next: false,
        }))
      : [
          {
            id: "scan",
            kind: "paragraph",
            bbox: [0, 0, 1, 1],
            text: "Scan 42",
            text_item_ids: [],
            rows: 0,
            cols: 0,
            cells: [],
            continues_from_previous: false,
            continues_on_next: false,
          },
        ];
  if (mode === "wrong_number") blocks[0].text = blocks[0].text.replace("10", "11");
  if (mode === "missing_cell" && table) blocks[0].cells.pop();
  return {
    location_id: page.locationId,
    image_hash: page.imageHash,
    confidence: 0.99,
    blank: false,
    blocks,
    images: page.imageLocations.map((i: Json) => ({
      location_id: i.id,
      block_ids: blocks.map((b: Json) => b.id),
      decorative: false,
      reason: "synthetic scanned page",
    })),
    links: page.links.map((l: Json) => ({ link_id: l.id, role: "citation" })),
    attachments: mode === "missing_attachment" ? [{ label: "Annex X", kind: "unresolved", url: null, pages: [] }] : [],
    unreadable_flags: [],
  };
}
function verify(input: Json) {
  const page = input.pages.find((p: Json) => p.locationId === input.target_location_id),
    candidate = input.candidates.find((c: Json) => c.location_id === page.locationId);
  const result = {
    location_id: page.locationId,
    image_hash: page.imageHash,
    candidate_hash: input.candidate_hash,
    page_ids: input.pages.map((p: Json) => p.locationId),
    complete: true,
    blank_confirmed: false,
    reading_order_exact: true,
    catalogue_complete: true,
    image_ids: page.imageLocations.map((i: Json) => i.id),
    text_item_ids: page.textItems.map((i: Json) => i.id),
    link_ids: page.links.map((i: Json) => i.id),
    checks: candidate.blocks.map((b: Json) => ({
      block_id: b.id,
      text_exact: true,
      numbers_exact: mode !== "uncertain_digits",
      layout_exact: true,
      table_grid_exact: true,
      figure_exact: true,
    })),
    previous_join: candidate.blocks[0]?.continues_from_previous ? "verified" : "none",
    next_join: candidate.blocks.at(-1)?.continues_on_next ? "verified" : "none",
    unreadable_flags: [],
  };
  if (mode === "missing_check") result.checks.pop();
  if (mode === "missing_page") result.page_ids.pop();
  return result;
}
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body),
    content = body.messages.at(-1).content,
    input = JSON.parse(typeof content === "string" ? content : content[0].text);
  sent.push({ input, body, raw: req.body });
  await hook(input);
  const output =
    input.phase === "extract"
      ? extract(input)
      : input.phase === "verify"
        ? verify(input)
        : {
            parts: input.parts.map((part: Json) => ({
              partId: part.partId,
              sourceHash: part.sourceHash,
              classification: "facts",
              facts: [{ statement: "合成测试事实", role: "scope", quote: part.source.replace(/<[^>]*>/g, "") }],
              zh: part.source
                .replace("Section 1. Mining threshold is 10.", "第 1 节。矿业阈值为 10。")
                .replace("Section 2. This exception is not waived.", "第 2 节。本例外不得豁免。"),
            })),
          };
  return {
    id: `synthetic-${sent.length}`,
    model: "synthetic-vision",
    choices: [{ message: { content: mode === "bad_json" ? "invalid" : JSON.stringify(output) }, finish_reason: "stop" }],
    usage,
  };
});
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`,
  LLM_API_KEY: "synthetic-only",
  LLM_MODEL: "explicit-synthetic-vision",
  LLM_VISION: "true",
  POLICY_VISION_MODEL: "default",
});
config.modelCallsEnabled = true;
await installUsageFixtureForModel("default", sql);
beforeEach(() => {
  mode = "pass";
  usage = { prompt_tokens: 100, completion_tokens: 50 };
  hook = async () => {};
  process.env.POLICY_VISION_MODEL = "default";
  process.env.LLM_VISION = "true";
  invalidateModelCache();
});
after(async () => {
  await provider.close();
  await closeDb();
});
async function fixture(body = readFileSync("tests/fixtures/policy/text.pdf")) {
  const sourceId = `vision-${tag()}`,
    url = `https://source.invalid/${sourceId}.pdf`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${sourceId},${sourceId},'external','policy',false)`;
  await grantDateFixture(sourceId, [url]);
  const original = await recordPolicyOriginal({
    sourceId,
    permissionVersion: 1,
    identity: { jurisdiction: "AR", authority: sourceId, documentType: "regulation", documentNumber: "test-1", officialUrl: url },
    versionKey: "v1",
    language: "en",
    kind: "original",
    officialTitle: "Synthetic PDF",
    expectedHead: null,
    catalogueClosed: false,
    resources: [{ url, mediaType: "application/pdf", attachment: false, required: true, state: "acquired", body, reason: null }],
  });
  return { ...original, sourceId, url, body };
}
function pdf(content: string[], image?: Buffer) {
  const objects: Buffer[] = [];
  const add = (s: string | Buffer) => {
    objects.push(typeof s === "string" ? Buffer.from(s) : s);
    return objects.length;
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let imageId = 0;
  if (image)
    imageId = add(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 256 /Height 128 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
        ),
        image,
        Buffer.from("\nendstream"),
      ]),
    );
  const pages: number[] = [];
  for (const stream of content) {
    const n = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pages.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${imageId ? `/XObject << /Im ${imageId} 0 R >>` : ""} >> /Contents ${n} 0 R >>`,
      ),
    );
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((p) => `${p} 0 R`).join(" ")}] >>`);
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\0synthetic\n")],
    offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), objects[i]!, Buffer.from("\nendobj\n"));
  }
  const xref = Buffer.concat(chunks).length;
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
        .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}
const tablePdf = () =>
  pdf(
    ["Cu 10", "Zn 20"].map((row) =>
      ["Metal", "Limit", ...row.split(" ")]
        .map((text, i) => `BT /F1 12 Tf ${72 + (i % 2) * 150} ${720 - Math.floor(i / 2) * 30} Td (${text}) Tj ET`)
        .join("\n"),
    ),
  );

test("explicit vision configuration, actual PNG transport, bounded resume, direct-PDF catalogue and AI17 provenance", async () => {
  const f = await fixture(),
    before = sent.length;
  delete process.env.POLICY_VISION_MODEL;
  assert.equal((await runPolicyVision(f.expressionId, profile, { root })).status, "needs_configuration");
  assert.equal(sent.length, before);
  process.env.POLICY_VISION_MODEL = "default";
  process.env.LLM_VISION = "false";
  assert.equal((await runPolicyVision(f.expressionId, profile, { root })).status, "needs_configuration");
  process.env.LLM_VISION = "true";
  const partial = await runPolicyVision(f.expressionId, profile, { root, maxRequests: 2 });
  assert.equal(partial.status, "partial");
  assert.equal(partial.requestsAttempted, 2);
  const done = await runPolicyVision(f.expressionId, profile, { root, maxRequests: 2 });
  assert.equal(done.status, "extracted");
  assert.ok("contentHash" in done);
  assert.equal(done.catalogueClosed, true);
  assert.equal(done.semantic_verified, false);
  assert.equal(sent.length, before + 4);
  const again = await loadPolicyVision(f.expressionId, profile);
  assert.equal(again?.contentHash, done.contentHash);
  assert.equal(sent.length, before + 4);
  for (const request of sent.slice(before)) {
    const parts = request.body.messages.at(-1).content;
    assert.equal(parts.length, 3);
    for (let i = 1; i < parts.length; i++)
      assert.equal(sha256(Buffer.from(parts[i].image_url.url.split(",")[1], "base64")), request.input.pages[i - 1].imageHash);
    const [receipt] = await sql`SELECT request FROM receipts WHERE request->>'transportHash'=${sha256(request.raw)}`;
    assert.equal(receipt?.request.transportBytes, Buffer.byteLength(request.raw));
    assert.equal(receipt?.request.userHash, sha256(JSON.stringify(parts)));
  }
  const extraction = await extractPolicyOriginal(f.expressionId, profile);
  assert.equal(extraction.state, "extracted");
  assert.equal(extraction.visualProof?.contentHash, done.contentHash);
  const fulltext = await runPolicyFulltext(f.expressionId, profile, { root });
  assert.equal(fulltext.status, "program_validated");
  assert.ok("runId" in fulltext);
  const stored = await readPolicyFulltextRun(fulltext.runId);
  assert.equal(stored?.run.plan.context.visualRunId, done.runId);
  assert.ok(stored?.run.plan.context.recipeVersion.endsWith(`/vision:${done.recipe}`));
  assert.equal((await loadPolicyVisionProof(done.runId))?.modelEvidence.length, 4);
});
test("actual scanned-image rendering and complete cross-page table keep coordinates, cells and numbers", async () => {
  const pixels = await sharp(
      Buffer.from('<svg width="256" height="128"><rect width="256" height="128" fill="white"/><text x="20" y="65" font-size="30">Scan 42</text></svg>'),
    )
      .removeAlpha()
      .raw()
      .toBuffer(),
    scan = await fixture(pdf(["q 512 0 0 256 50 450 cm /Im Do Q"], deflateSync(pixels)));
  const scanned = await runPolicyVision(scan.expressionId, profile, { root, maxRequests: 10 });
  assert.equal(scanned.status, "extracted");
  assert.ok("resources" in scanned);
  assert.match(scanned.resources[0]!.nodes[0]!.text, /42/);
  const scanInput = sent.find((s) => s.input.phase === "extract" && s.input.pages[0].resourceUrl === scan.url)!.input;
  assert.equal(scanInput.pages[0].textItems.length, 0);
  assert.equal(scanInput.pages[0].imageLocations.length, 1);
  const table = await fixture(tablePdf()),
    done = await runPolicyVision(table.expressionId, profile, { root, maxRequests: 10 });
  assert.equal(done.status, "extracted");
  assert.ok("resources" in done);
  const nodes = done.resources[0]!.nodes;
  assert.equal(nodes.length, 1);
  assert.match(nodes[0]!.html!, /Cu/);
  assert.match(nodes[0]!.html!, /Zn/);
  assert.equal((nodes[0]!.html!.match(/Metal/g) ?? []).length, 1);
  assert.equal((nodes[0]!.html!.match(/<tr>/g) ?? []).length, 3);
  assert.match(nodes[0]!.selector!, /1,2/);
  assert.deepEqual(
    nodes[0]!.visualLocations?.map((location) => location.page),
    [1, 2],
  );
});
test("missing cells, altered digits, missing checks/page IDs and malformed JSON reject without repurchase", async () => {
  for (const fault of ["missing_cell", "wrong_number", "missing_check", "missing_page", "bad_json"]) {
    mode = fault;
    const f = await fixture(fault === "missing_cell" ? tablePdf() : undefined);
    const result = await runPolicyVision(f.expressionId, profile, { root, maxRequests: 20 });
    assert.equal(result.status, "invalid_output", fault);
    const count = sent.length;
    assert.equal((await runPolicyVision(f.expressionId, profile, { root, maxRequests: 20 })).status, "invalid_output");
    assert.equal(sent.length, count);
    assert.equal((await extractPolicyOriginal(f.expressionId, profile)).state, "incomplete");
  }
});
test("unproven numbers and missing attachment stay explicit gaps; no usage blocks further payment", async () => {
  for (const fault of ["uncertain_digits", "missing_attachment"]) {
    mode = fault;
    const f = await fixture(),
      result = await runPolicyVision(f.expressionId, profile, { root, maxRequests: 20 });
    assert.equal(result.status, "incomplete");
    assert.ok(result.gaps.length);
    assert.equal(await loadPolicyVision(f.expressionId, profile), null);
  }
  mode = "pass";
  usage = null;
  const f = await fixture(),
    before = sent.length;
  assert.equal((await runPolicyVision(f.expressionId, profile, { root, maxRequests: 10 })).status, "blocked_unknown");
  assert.equal(sent.length, before + 1);
  assert.equal((await runPolicyVision(f.expressionId, profile, { root, maxRequests: 10 })).status, "blocked_unknown");
  assert.equal(sent.length, before + 1);
});
test("pause during paid response retains actual receipt; explicit resume reuses it and original CAS stays current", async () => {
  const f = await fixture(),
    before = sent.length;
  let once = true;
  hook = async () => {
    if (once) {
      once = false;
      await setPolicyProcessingPaused(f.expressionId, { expectedVersion: 1, paused: true, reason: "synthetic pause", actor: "test" });
    }
  };
  assert.equal((await runPolicyVision(f.expressionId, profile, { root, maxRequests: 10 })).status, "stale");
  assert.equal((await runPolicyVision(f.expressionId, profile, { root })).status, "paused");
  await setPolicyProcessingPaused(f.expressionId, { expectedVersion: 2, paused: false, reason: "synthetic resume", actor: "test" });
  hook = async () => {};
  const done = await runPolicyVision(f.expressionId, profile, { root, maxRequests: 10 });
  assert.equal(done.status, "extracted");
  assert.equal(sent.length, before + 4);
  assert.ok("runId" in done);
  await sql`UPDATE policy.vision_pages SET image_bytes=image_bytes||'x'::bytea WHERE run_id=${done.runId!}`;
  await assert.rejects(() => loadPolicyVisionProof(done.runId!), /vision_page_bytes_changed/);
});
test("pure structure validator rejects exact-location substitutions and render limits never truncate", async () => {
  const corrupt = await fixture(Buffer.from("%PDF-corrupted")),
    before = sent.length;
  const rejected = await runPolicyVision(corrupt.expressionId, profile, { root });
  assert.equal(rejected.status, "incomplete");
  assert.match(rejected.gaps[0]!, /pdf_render_failed/);
  assert.equal(sent.length, before);
  const f = await fixture();
  await assert.rejects(() => renderPolicyPdf({ url: f.url, sha256: sha256(f.body), body: f.body }, { ...profile, maxPages: 1 }), /page count/);
  const rendered = await renderPolicyPdf({ url: f.url, sha256: sha256(f.body), body: f.body }, profile),
    page = rendered.pages[0]!,
    input = { target_location_id: page.locationId, pages: rendered.pages };
  const candidate = VisionPageReply.parse(extract(input));
  assert.throws(() => checkVisionPage(page, { ...candidate, location_id: "different" }), /identity/);
  const proof = verify({ ...input, candidates: [candidate], candidate_hash: sha256(stableJson(candidate)) });
  assert.throws(() => checkVisionVerification(page, candidate, rendered.pages, { ...proof, page_ids: [page.locationId, page.locationId] }), /coverage/);
});
