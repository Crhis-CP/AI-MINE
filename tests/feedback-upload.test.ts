import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

const sql = dbOf("feedback");

config.dataDir = await mkdtemp(path.join(tmpdir(), "amp-upload-"));
const app = await buildApp("public-api");
after(async () => {
  await app.close();
  await closeDb();
  await rm(config.dataDir, { recursive: true });
});

async function upload(file: Buffer, ip: string) {
  const form = new FormData();
  form.set("content", "手机截图反馈，文字保持不变");
  form.set("email", "reader@example.com");
  form.set("pageUrl", "/daily");
  form.set("screenshot", new File([new Uint8Array(file)], "screenshot.png", { type: "image/png" }));
  const request = new Request("http://local/api/site/feedback", { method: "POST", body: form });
  const payload = Buffer.from(await request.arrayBuffer());
  return app.inject({
    method: "POST",
    url: "/api/site/feedback",
    headers: { "idempotency-key": randomUUID(), "content-type": request.headers.get("content-type")!, "x-real-ip": ip },
    payload,
  });
}

test("a valid 2 MiB multipart screenshot is decoded and privately re-encoded", async () => {
  const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const file = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 - png.length)]);
  const result = await upload(file, "203.0.113.211");
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.headers["cache-control"], "no-store");
  const [row] = await sql`SELECT content,email,page_url,screenshot_key FROM feedback WHERE id = ${result.json().id}`;
  assert.equal(row!.content, "手机截图反馈，文字保持不变");
  assert.equal(row!.email, "reader@example.com");
  assert.equal(row!.page_url, "/daily");
  const stored = await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6)));
  assert.deepEqual(await sharp(stored).raw().toBuffer(), await sharp(file).raw().toBuffer());
  assert.equal((await sharp(stored).metadata()).exif, undefined);
});

test("malformed multipart and screenshots above the approved 2 MiB limit are rejected", async () => {
  const bad = await app.inject({
    method: "POST",
    url: "/api/site/feedback",
    headers: { "content-type": "multipart/form-data; boundary=missing" },
    payload: Buffer.from("bad"),
  });
  assert.equal(bad.statusCode, 400);
  const result = await upload(Buffer.alloc(2 * 1024 * 1024 + 1), "203.0.113.212");
  assert.equal(result.statusCode, 400);
  assert.match(result.json().detail, /2MB/);
});

test("the JSON screenshot sent by an already-open tab remains accepted", async () => {
  const file = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const result = await app.inject({
    method: "POST",
    url: "/api/site/feedback",
    headers: { "idempotency-key": randomUUID(), "x-real-ip": "203.0.113.213" },
    payload: { content: "旧标签页继续提交有效反馈文字", screenshot: { mime: "image/png", data: file.toString("base64") } },
  });
  assert.equal(result.statusCode, 201);
  const [row] = await sql`SELECT screenshot_key FROM feedback WHERE id = ${result.json().id}`;
  const stored = await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6)));
  assert.deepEqual(await sharp(stored).raw().toBuffer(), await sharp(file).raw().toBuffer());
  assert.equal((await sharp(stored).metadata()).exif, undefined);
});

test("feedback HTTP replay is stable and a missing key gives an actionable rejection", async () => {
  const headers = { "idempotency-key": randomUUID(), "x-real-ip": "203.0.113.215" },
    payload = { content: "反馈响应丢失后重交同一请求不会重复" };
  const first = await app.inject({ method: "POST", url: "/api/site/feedback", headers, payload });
  const replay = await app.inject({ method: "POST", url: "/api/site/feedback", headers, payload });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json(), first.json());
  const conflict = await app.inject({ method: "POST", url: "/api/site/feedback", headers, payload: { content: "更改正文后同一幂等编号应返回冲突" } });
  assert.equal(conflict.statusCode, 409, conflict.body);
  const missing = await app.inject({ method: "POST", url: "/api/site/feedback", payload });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().detail, /提交编号|刷新/);
});

test("feedback pageUrl cannot whitelist an attacker site through the request Host", async () => {
  const result = await app.inject({
    method: "POST",
    url: "/api/site/feedback",
    headers: { host: "untrusted.example.test", "idempotency-key": randomUUID() },
    payload: { content: "验证请求域名不可替代可信站点配置", pageUrl: "https://untrusted.example.test/daily" },
  });
  assert.equal(result.statusCode, 400, result.body);
  assert.match(result.json().detail, /AI矿策网站地址/);
});
