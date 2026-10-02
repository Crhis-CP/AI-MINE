// secrets: a committed key is stopped by the project rules and, when the pinned binary is present, by
// trufflehog. Fake keys are assembled at run time so this file itself never matches a rule.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../lib.ts";
import { scanLine, scanPatch, scanSecrets } from "../secrets.ts";
import { memoryLog, repo, scratch } from "./helpers.ts";

const fake = {
  tencent: `AKID${"Q7b2".repeat(8)}`,
  privateKey: ["-----BEGIN", "RSA PRIVATE", "KEY-----"].join(" "),
  model: `sk-${"Zq4mT9vX2c".repeat(3)}`,
  google: `AIza${"Sy".repeat(17)}x`,
  feishu: `app_secret = "${"Fs8k".repeat(8)}"`,
  url: ["postgres://app", ":Tr0ub4dor", "@db.prod-1.internal:5432/app"].join(""),
};

test("each project rule catches its kind of key", () => {
  assert.deepEqual(scanLine(`const id = "${fake.tencent}";`), ["tencent-secret-id"]);
  assert.deepEqual(scanLine(fake.privateKey), ["private-key"]);
  assert.deepEqual(scanLine(`LLM_API_KEY=${fake.model}`), ["model-api-key"]);
  assert.deepEqual(scanLine(`key: "${fake.google}"`), ["google-api-key"]);
  assert.deepEqual(scanLine(fake.feishu), ["feishu-app-secret"]);
  assert.deepEqual(scanLine(`DATABASE_URL=${fake.url}`), ["credentials-in-url"]);
});

test("placeholders, local addresses and marked examples are not findings", () => {
  assert.deepEqual(scanLine("DATABASE_URL=postgres://postgres:ci@127.0.0.1:5432/amp_ci"), []);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a docker compose placeholder, taken literally
  assert.deepEqual(scanLine("postgres://app:${POSTGRES_PASSWORD}@db:5432/app"), []);
  assert.deepEqual(scanLine("https://user:<password>@example.com/x"), []);
  assert.deepEqual(scanLine(`const k = "${fake.model}"; // secret-scan:allow documented test vector`), []);
});

test("added lines are reported with file, line and commit; removed lines are not", () => {
  const patch = [
    "\u0001aaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "diff --git a/.env.example b/.env.example",
    "--- a/.env.example",
    "+++ b/.env.example",
    "@@ -3,0 +4,2 @@",
    "+SITE_URL=http://127.0.0.1:3000",
    `+TENCENT_SECRET_ID=${fake.tencent}`,
    "@@ -9 +11 @@",
    `-OLD=${fake.model}`,
    "+NEW=",
  ].join("\n");
  assert.deepEqual(scanPatch(patch), [{ rule: "tencent-secret-id", file: ".env.example", line: 5, commit: "aaaaaaaaaaaa" }]);
});

test("a key committed in the range is found in the real git history", async (t) => {
  const dir = scratch();
  const [base, , head] = repo(dir, [
    { "README.md": "x\n" },
    { "config/app.env": `TENCENT_SECRET_ID=${fake.tencent}\nDATABASE_URL=${fake.url}\n` },
    { "config/app.env": "TENCENT_SECRET_ID=\n" }, // removed again: still in the history, still a finding
  ]);
  const tools = path.join(ROOT, ".tools");
  const pinned = existsSync(tools) && readdirSync(tools).some((d) => d.startsWith("trufflehog-") && existsSync(path.join(tools, d, "trufflehog")));
  if (!pinned) {
    // Without the pinned binary (the secrets stage downloads it), check the project rules on their own.
    const patch = execFileSync("git", ["log", "--reverse", "--format=%x01%H", "-p", "--unified=0", "--no-color", `${base}..${head}`], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.deepEqual(
      scanPatch(patch).map((f) => f.rule),
      ["tencent-secret-id", "credentials-in-url"],
    );
    t.diagnostic("trufflehog not downloaded yet: checked the project rules only");
    return;
  }
  const scan = await scanSecrets(base, head, memoryLog(dir), { PATH: process.env.PATH, HOME: process.env.HOME }, dir);
  assert.equal(scan.scanners.project_rules, 2);
  assert.ok(scan.findings >= 2);
});
