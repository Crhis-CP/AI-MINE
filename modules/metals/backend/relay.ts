import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { COCHILCO_ORIGIN, PRICE_RELAY_HEADERS as H, priceRelaySigningText, priceRelayByteLimit, priceRelaySourceUrl } from "@amp/contracts/metal-price-relay";
import { config } from "@amp/backend/config";
import { guardedFetch, type GuardedFetchOptions, type GuardedResponse } from "@amp/backend/lib/http-fetch";

export async function fetchCochilco(url: string, options: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  if (!config.metalPriceRelayUrl) return guardedFetch(url, options);
  return fetchThroughPriceRelay(url, config.metalPriceRelayUrl, readFileSync(config.metalPriceRelayKeyFile, "utf8"), guardedFetch);
}

export async function fetchThroughPriceRelay(
  url: string,
  endpoint: string,
  privateKey: string,
  get: typeof guardedFetch,
  now = Date.now(),
): Promise<GuardedResponse> {
  const source = new URL(url);
  if (source.origin !== COCHILCO_ORIGIN || source.search || source.hash || source.username || source.password || priceRelaySourceUrl(source.pathname) !== url)
    throw new Error("Price source outside the allowed relay scope");
  const relay = new URL(endpoint);
  if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== "/v1/cochilco")
    throw new Error("Price relay must be a fixed HTTPS endpoint");
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 signing key required");
  const issuedAt = String(Math.floor(now / 1000));
  relay.searchParams.set("resource", source.pathname);
  const response = await get(relay.href, {
    maxBytes: priceRelayByteLimit(source.pathname),
    maxRedirects: 0,
    followRedirects: false,
    timeoutMs: 35_000,
    headers: { [H.issuedAt]: issuedAt, [H.signature]: sign(null, Buffer.from(priceRelaySigningText(source.pathname, issuedAt)), key).toString("base64url") },
  });
  if (
    response.status !== 200 ||
    response.url !== relay.href ||
    response.headers.get(H.sourceUrl) !== url ||
    response.headers.get(H.bodyHash) !== createHash("sha256").update(response.body).digest("hex")
  )
    throw new Error("Price relay did not return a verified original document");
  return { ...response, url };
}
