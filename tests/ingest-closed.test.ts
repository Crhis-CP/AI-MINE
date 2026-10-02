// The external push entrance (POST /api/ingest/items, F-ACQ-07) stays closed in the first version: the
// api does not register it (adoption 4.5 row 7), so even a request carrying the configured token is a 404.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@amp/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

const TOKEN = "closed-entrance-check-0123456789";
process.env.INGEST_TOKEN = TOKEN;
const app = await buildApp();
after(async () => {
  delete process.env.INGEST_TOKEN;
  await app.close();
  await closeDb();
});

test("the external push entrance is not served, even with the ingest token", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/ingest/items",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: { items: [] },
  });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal((res.json() as { code: string }).code, "not_found");
});
