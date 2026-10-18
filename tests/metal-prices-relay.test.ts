import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createPriceRelay } from "../deploy/metal-price-relay/handler.ts";
import { fetchThroughPriceRelay } from "../modules/metals/backend/relay.ts";
import { COCHILCO_LIST_PATH, COCHILCO_ORIGIN, PRICE_RELAY_HEADERS as H, priceRelaySigningText } from "@amp/contracts/metal-price-relay";
import type { guardedFetch } from "@amp/backend/lib/http-fetch";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const now = Date.parse("2026-10-13T19:00:00Z");
const endpoint = "https://price-fetch.example/v1/cochilco";
const source = COCHILCO_ORIGIN + COCHILCO_LIST_PATH;
const signed = (resource = COCHILCO_LIST_PATH, time = now, key = keys.privateKey) => {
  const issuedAt = String(Math.floor(time / 1000));
  const url = new URL(endpoint);
  url.searchParams.set("resource", resource);
  return new Request(url, {
    headers: { [H.issuedAt]: issuedAt, [H.signature]: sign(null, Buffer.from(priceRelaySigningText(resource, issuedAt)), key).toString("base64url") },
  });
};

test("only a timely signed fixed source request reaches the official source", async () => {
  let calls = 0;
  const handler = createPriceRelay(
    publicKey,
    async (url, options) => {
      calls++;
      assert.equal(url, source);
      assert.equal(options?.redirect, "error");
      return new Response("<html>official fixture</html>");
    },
    () => now,
  );
  for (const request of [
    new Request(endpoint + "?resource=" + COCHILCO_LIST_PATH),
    signed(COCHILCO_LIST_PATH, now - 91_000),
    signed(COCHILCO_LIST_PATH, now + 91_000),
    signed(COCHILCO_LIST_PATH, now, generateKeyPairSync("ed25519").privateKey),
    new Request(endpoint + "?resource=https://other.example"),
    new Request(signed(), { method: "POST" }),
  ])
    assert.notEqual((await handler(request)).status, 200);
  assert.equal(calls, 0);
  const transport: typeof guardedFetch = async (url, options) => {
    const result = await handler(new Request(url, { headers: options?.headers }));
    const body = Buffer.from(await result.arrayBuffer());
    return { status: result.status, headers: result.headers, body, text: () => body.toString(), url };
  };
  const result = await fetchThroughPriceRelay(source, endpoint, privateKey, transport, now);
  assert.equal(result.url, source);
  assert.equal(result.text(), "<html>official fixture</html>");
  await assert.rejects(
    fetchThroughPriceRelay(source, endpoint, privateKey, async (...args) => ({ ...(await transport(...args)), body: Buffer.from("tampered") }), now),
    /verified/,
  );
});

test("redirect errors and oversized or fake PDF responses cannot become prices", async () => {
  const pdf = "/web/download/1493/octubre-2026/10000/rueda-13-10-2026.pdf";
  for (const get of [
    async () => {
      throw new Error("redirect");
    },
    async () => new Response("not PDF"),
    async () => new Response("x", { headers: { "content-length": "9999999" } }),
    async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
  ]) {
    assert.equal((await createPriceRelay(publicKey, get, () => now)(signed(pdf))).status, 502);
  }
});
