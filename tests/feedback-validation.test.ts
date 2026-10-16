import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import sharp from "sharp";
import { config } from "@amp/backend/config";
import { closeDb, feedbackSql as sql } from "@amp/backend/db";
import { submitFeedback } from "@amp/backend/operations/feedback";

const dir = await mkdtemp(path.join(tmpdir(), "feedback-validation-"));
config.dataDir = dir;
config.siteUrl = "https://trusted.example.test";
after(async () => {
  await closeDb();
  await rm(dir, { recursive: true, force: true });
});
let source = 0;
const request = () => ({
  idempotencyKey: randomUUID(),
  content: "合成反馈用于核对文件与页面输入边界",
  ip: `synthetic-image-${source++}`,
  userAgent: "fixture",
});
const image = () => sharp({ create: { width: 12, height: 10, channels: 3, background: "#ad2211" } });

test("actual PNG/JPEG/WebP are decoded and privately re-encoded without EXIF even when MIME is false", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const bytes = await image()
      .withExif({ IFD0: { Copyright: "PRIVATE EXIF" } })
      .toFormat(format)
      .toBuffer();
    const { id } = await submitFeedback({ ...request(), screenshot: { mime: "image/gif", data: bytes } });
    const [row] = await sql`SELECT screenshot_key FROM feedback WHERE id=${id}`;
    assert.match(row!.screenshot_key, new RegExp(`^local:[a-f0-9]{24}\\.${format}$`));
    const stored = await readFile(path.join(dir, "feedback-screenshots", row!.screenshot_key.slice(6)));
    const metadata = await sharp(stored).metadata();
    assert.equal(metadata.format, format);
    assert.equal(metadata.width, 12);
    assert.equal(metadata.height, 10);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
  }
});

test("forged MIME, GIF/SVG, empty/truncated data and excessive pixels never enter the inbox", async () => {
  const samples = [
    Buffer.alloc(0),
    Buffer.from("<svg></svg>"),
    Buffer.from("<html>fake png</html>"),
    Buffer.from("GIF89a"),
    (await image().png().toBuffer()).subarray(0, 32),
    await sharp({ create: { width: 16_001, height: 1, channels: 3, background: "white" } })
      .png()
      .toBuffer(),
    await sharp({ create: { width: 6400, height: 6300, channels: 3, background: "white" } })
      .png()
      .toBuffer(),
  ];
  const before = (await sql`SELECT count(*)::int n FROM feedback`)[0]!.n;
  for (const data of samples) await assert.rejects(submitFeedback({ ...request(), screenshot: { mime: "image/png", data } }), /PNG、JPEG 或 WebP/);
  assert.equal((await sql`SELECT count(*)::int n FROM feedback`)[0]!.n, before);
  const long = await sharp({ create: { width: 1, height: 16_000, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  assert.ok((await submitFeedback({ ...request(), screenshot: { mime: "image/png", data: long } })).id);
});

test("page URLs use only configured site origin and preserve the full supported 2048-character value", async () => {
  const userInfoUrl = new URL("/a", config.siteUrl);
  userInfoUrl.username = "synthetic-user";
  userInfoUrl.password = randomUUID();
  for (const pageUrl of ["/daily", "https://trusted.example.test/all?q=铜矿", `/${"a".repeat(2047)}`]) {
    const { id } = await submitFeedback({ ...request(), pageUrl });
    assert.equal((await sql`SELECT page_url FROM feedback WHERE id=${id}`)[0]!.page_url, pageUrl);
  }
  for (const pageUrl of [
    "https://evil.example/daily",
    "//evil.example/a",
    "/\\evil.example/a",
    "javascript:alert(1)",
    "data:text/plain,x",
    "ftp://trusted.example.test/a",
    userInfoUrl.href,
    "http://trusted.example.test/a",
    "https://trusted.example.test:999/a",
    "https://trusted.example.test.evil/a",
    "relative",
    `/${"a".repeat(2048)}`,
  ]) {
    await assert.rejects(submitFeedback({ ...request(), pageUrl }), /AI矿策网站地址/);
  }
});
