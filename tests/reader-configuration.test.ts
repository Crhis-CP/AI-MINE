import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("reader configuration distinguishes missing and unreadable credentials without exposing values or probing", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "reader-private-"));
  try {
    mkdirSync(path.join(directory, "collectors.env"));
    const script = `
      const { bodyReaderConfiguration } = await import(${JSON.stringify(new URL("../packages/backend/src/config.ts", import.meta.url).href)});
      const results = [bodyReaderConfiguration()];
      process.env.JINA_BODY_FALLBACK = "false";
      results.push(bodyReaderConfiguration());
      process.env.JINA_BODY_FALLBACK = "true";
      process.env.JINA_API_KEY = "synthetic-reader-key-never-return";
      const { bodyReadingKey } = await import(${JSON.stringify(new URL("../packages/backend/src/content/body-reading-key.ts", import.meta.url).href)});
      const { readPdfText } = await import(${JSON.stringify(new URL("../packages/backend/src/content/pdf-text.ts", import.meta.url).href)});
      const { textPdf } = await import(${JSON.stringify(new URL("./pdf-fixture.ts", import.meta.url).href)});
      results.push({ ...bodyReaderConfiguration(),
        key: bodyReadingKey({ id: "fixture", revision: 1, url: "https://example.invalid/file.pdf" }, {}, 1),
        text: await readPdfText(textPdf("Local reading remains available.")) });
      process.env.JINA_API_KEY = "   ";
      results.push(bodyReaderConfiguration());
      console.log(JSON.stringify(results));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { AMP_CREDENTIALS_DIR: directory },
      encoding: "utf8",
      timeout: 10_000,
    });
    const results = JSON.parse(output);
    assert.deepEqual(
      results.map((r: { state: string }) => r.state),
      ["unavailable", "disabled", "configured", "missing"],
    );
    assert.match(results[2].detail, /尚未验证/);
    assert.match(results[2].key, /^[0-9a-f]{64}$/);
    assert.match(results[2].text, /Local reading remains available/);
    assert.ok(!output.includes(directory));
    assert.ok(!output.includes("synthetic-reader-key-never-return"));
    assert.ok(!output.includes("EISDIR"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
