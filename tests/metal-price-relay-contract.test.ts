import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COCHILCO_LIST_PATH,
  PriceRelayRequest,
  PriceRelayResource,
  priceRelayByteLimit,
  priceRelaySigningText,
  priceRelaySourceUrl,
} from "@amp/contracts/metal-price-relay";

test("only approved original-file paths are representable, not arbitrary destinations or encoded escapes", () => {
  const pdf = "/web/download/1037/octubre-2026/16976/rueda-13-10-2026.pdf";
  for (const resource of [COCHILCO_LIST_PATH, pdf]) assert.equal(PriceRelayResource.parse(resource), resource);
  assert.equal(priceRelaySourceUrl(pdf), `https://www.cochilco.cl${pdf}`);
  assert.equal(priceRelayByteLimit(pdf), 4194304);
  assert.equal(priceRelayByteLimit(COCHILCO_LIST_PATH), 2097152);
  for (const resource of [
    "https://example.com/x.pdf",
    "//example.com/",
    "/web/../admin",
    "/web/la-rueda-diaria/?url=https://example.com",
    "/web/download/1037/octubre-2026/16976/%2eru.pdf",
  ])
    assert.equal(PriceRelayResource.safeParse(resource).success, false);
  const request = { resource: pdf, issuedAt: "1791913233", signature: "a".repeat(86) };
  assert.equal(PriceRelayRequest.safeParse(request).success, true);
  assert.equal(PriceRelayRequest.safeParse({ ...request, headers: { Authorization: "not-allowed" } }).success, false);
  assert.equal(PriceRelayRequest.safeParse({ ...request, issuedAt: "01791913233" }).success, false);
  assert.notEqual(priceRelaySigningText(pdf, request.issuedAt), priceRelaySigningText(COCHILCO_LIST_PATH, request.issuedAt));
  assert.notEqual(priceRelaySigningText(pdf, request.issuedAt), priceRelaySigningText(pdf, "1791913234"));
});
