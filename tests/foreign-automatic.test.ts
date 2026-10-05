import "./setup.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { gate } from "./setup.ts";
import { foreignFixture } from "./foreign-automatic-fixture.ts";

const mixed = [
  ["MIXED_EN", "A copper project named 铜 is not yet approved. The English report states conditions and exceptions."],
  ["MIXED_ES", "La empresa 铜 informa que el proyecto no está aprobado y las condiciones siguen pendientes."],
  ["JAPANESE", "銅鉱山の計画は承認されていません。条件と例外を確認する必要があります。"],
] as const;

async function unidentifiedStage(t: TestContext) {
  const f = await foreignFixture(t, {
    name: "unknown-language-fixture",
    samples: mixed.map(([marker, text]) => ({ marker, title: marker, label: "PASS", body: `${marker} ${text} `.repeat(8) })),
  });
  await f.until("unknown languages recorded", async () => (await f.rows()).length === 3 && (await f.rows()).every((row) => row.processing_state === "failed"));
  for (const row of await f.rows()) {
    assert.equal(row.language, null);
    assert.match(row.processing_error, /language_unidentified/);
    assert.equal((await f.reader.inject(`/api/site/items/${row.id}`)).statusCode, 404);
  }
  assert.equal(f.calls.length, 0, "no classification or translation payment occurs before language is identified");
  assert.equal((await f.sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
  await f.until(
    "unknown source settled",
    async () => (await f.sql`SELECT status FROM fetch_runs WHERE source_id='unknown-language-fixture' ORDER BY id DESC LIMIT 1`)[0]?.status === "ok",
  );
  await f.closeSurfaces();
}

test("BR-ENR-07: source queue prepares low and selected foreign material, then first publishes only complete current Chinese", async (t) => {
  const release = gate();
  t.after(() => release.open());
  await unidentifiedStage(t);
  const markers = ["FOREIGN_LOW", "FOREIGN_SELECTED", "FOREIGN_WITHDRAWN"];
  const f = await foreignFixture(t, {
    name: "foreign-complete-fixture",
    reuseWorker: true,
    language: "EN-us",
    samples: markers.map((marker, i) => ({
      marker,
      title: `Copper processing ${marker}`,
      label: "PASS",
      score: i === 1 ? 80 : 10,
      body:
        `${marker}_FIRST: A self-authored copper processing example. `.repeat(8) +
        "</p><p>" +
        `${marker}_LAST: Final conditions and exceptions apply. `.repeat(4),
    })),
    translate: async (marker, text) => {
      await release.promise;
      return { text: `合成中文全文 ${marker} ${text.includes("_LAST") ? "末段条件与例外" : "首段材料"}，只用于工程验证。` };
    },
  });
  await f.until(
    "analysis complete, translation held",
    async () =>
      (await f.rows()).length === 3 &&
      (await f.rows()).every((row) => row.processing_state === "analyzed" && row.visibility === "withdrawn") &&
      f.calls.some((call) => call.step === "translate"),
  );
  const rows = await f.rows();
  for (const row of rows) {
    assert.equal(row.language, "en-US");
    assert.equal(row.visibility, "withdrawn");
    assert.equal((await f.reader.inject(`/api/site/items/${row.id}`)).statusCode, 404);
  }
  const withdrawn = rows.find((row) => row.title.includes("FOREIGN_WITHDRAWN"))!;
  const withdrawal = await f.admin.inject({
    method: "POST",
    url: `/api/admin/content/${withdrawn.id}/visibility`,
    headers: f.headers,
    payload: { visibility: "withdrawn", reason: "synthetic manual withdrawal", version: 0 },
  });
  assert.equal(withdrawal.statusCode, 200, withdrawal.body);
  const before = f.calls.length;
  await f.reader.inject("/api/site/pool");
  await f.reader.inject("/api/v1/items?mode=selected");
  await f.reader.inject("/feed.xml");
  assert.equal(f.calls.length, before, "reader requests never progress the held worker");
  release.open();
  await f.until("both complete translations published", async () =>
    (await f.rows()).filter((row) => row.id !== withdrawn.id).every((row) => row.visibility === "public"),
  );
  for (const row of (await f.rows()).filter((row) => row.id !== withdrawn.id)) {
    const res = await f.reader.inject(`/api/site/items/${row.id}`);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json().body;
    assert.equal(body.complete, true);
    assert.match(body.zh, /末段条件与例外/);
    assert.equal(body.original, null);
    assert.equal(row.selected, row.title.includes("FOREIGN_SELECTED"));
  }
  assert.equal((await f.reader.inject(`/api/site/items/${withdrawn.id}`)).statusCode, 404);
  assert.ok(!f.calls.some((call) => call.marker === "FOREIGN_WITHDRAWN" && call.step === "translate"));
  const calls = f.calls.filter((call) => call.step === "translate");
  assert.equal(calls.length, 4);
  const [receipts] =
    await f.sql`SELECT count(*)::int AS n FROM receipts WHERE purpose='translate_body' AND status='completed' AND response_attempt_id IS NOT NULL`;
  assert.equal(receipts.n, 4);
  const snapshot = f.calls.length;
  for (const row of rows) await f.reader.inject(`/api/site/items/${row.id}`);
  assert.equal(f.calls.length, snapshot);
  await f.closeSurfaces();
  const bad = await foreignFixture(t, {
    name: "foreign-bad-fixture",
    reuseWorker: true,
    language: "es",
    samples: [
      {
        marker: "BAD_TRANSLATION",
        title: "Ensayo de cobre",
        label: "PASS",
        body: "BAD_TRANSLATION: El proyecto de cobre tiene condiciones pendientes. ".repeat(8),
      },
      {
        marker: "SCOPE_UNKNOWN",
        title: "Datos pendientes",
        label: "UNKNOWN",
        body: "SCOPE_UNKNOWN: Los datos del proyecto requieren comprobación. ".repeat(8),
      },
    ],
    // UNKNOWN goes on like PASS: it is translated and published once its Chinese is complete.
    translate: async (marker) => (marker === "SCOPE_UNKNOWN" ? { text: `合成中文全文 ${marker}，只用于工程验证。` } : { text: "Only untranslated English" }),
  });
  await bad.until(
    "bad translation durably rejected",
    async () => (await bad.sql`SELECT count(*)::int AS n FROM enrichment.translation_segments WHERE state='failed'`)[0].n > 0,
  );
  await bad.until("scope unknown published", async () =>
    (await bad.rows()).every((row) => row.processing_state === "analyzed" && (row.visibility === "public") === row.title.includes("Datos")),
  );
  for (const row of await bad.rows())
    assert.equal((await bad.reader.inject(`/api/site/items/${row.id}`)).statusCode, row.title.includes("Datos") ? 200 : 404, row.title);
  const badId = (await bad.rows()).find((row) => row.title.includes("Ensayo"))!.id;
  await bad.until(
    "failed job retained for retry",
    async () =>
      (
        await bad.sql`SELECT state FROM pgboss.job
    WHERE name='content.translate' AND data->>'articleId'=${badId} ORDER BY created_on DESC LIMIT 1`
      )[0]?.state === "retry",
  );
  const jobs = await bad.sql`SELECT id FROM pgboss.job WHERE name='content.translate' AND data->>'articleId'=${badId} AND state='retry'`;
  for (const job of jobs) await bad.boss.cancel("content.translate", job.id);
  await bad.closeSurfaces();
  const restricted = await foreignFixture(t, {
    name: "foreign-restricted-fixture",
    reuseWorker: true,
    language: "en",
    siteFulltext: false,
    samples: [
      { marker: "RESTRICTED", title: "Copper notice", label: "PASS", body: "RESTRICTED: A self-authored copper operation reports changes. ".repeat(8) },
    ],
  });
  await restricted.until("restricted material processed privately", async () => (await restricted.rows())[0]?.processing_state === "analyzed");
  const [privateRow] = await restricted.rows();
  assert.equal((await restricted.reader.inject(`/api/site/items/${privateRow.id}`)).statusCode, 404);
  assert.ok(!restricted.calls.some((call) => call.step === "translate"), "no source-specific summary-only exception is invented");
});
