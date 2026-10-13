import { createHash, createPublicKey, verify } from "node:crypto";
import {
  COCHILCO_LIST_PATH,
  PRICE_RELAY_HEADERS as H,
  PRICE_RELAY_MAX_AGE_SECONDS,
  PriceRelayRequest,
  priceRelaySigningText,
  priceRelaySourceUrl,
  priceRelayByteLimit,
} from "@amp/contracts/metal-price-relay";

/** The overseas service receives only a public key, never a model/database/server secret. */
export function createPriceRelay(publicKey: string, get: typeof fetch = fetch, now = Date.now) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 public key required");
  return async (request: Request): Promise<Response> => {
    const reject = (status: number) => new Response("Request unavailable", { status, headers: { "cache-control": "no-store" } });
    if (request.method !== "GET") return reject(405);
    const url = new URL(request.url);
    if (url.pathname !== "/v1/cochilco" || [...url.searchParams.keys()].join() !== "resource") return reject(400);
    const parsed = PriceRelayRequest.safeParse({
      resource: url.searchParams.get("resource"),
      issuedAt: request.headers.get(H.issuedAt),
      signature: request.headers.get(H.signature),
    });
    if (!parsed.success) return reject(403);
    const { resource, issuedAt, signature } = parsed.data;
    if (Math.abs(Math.floor(now() / 1000) - Number(issuedAt)) > PRICE_RELAY_MAX_AGE_SECONDS) return reject(403);
    if (!verify(null, Buffer.from(priceRelaySigningText(resource, issuedAt)), key, Buffer.from(signature, "base64url"))) return reject(403);
    const source = priceRelaySourceUrl(resource);
    try {
      const response = await get(source, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        headers: {
          "user-agent": "AI-MINE-Price/1.0 (+https://aiminingpolicy.com/about)",
          accept: resource === COCHILCO_LIST_PATH ? "text/html" : "application/pdf",
        },
      });
      if (response.status !== 200 || !response.body) return reject(502);
      const limit = priceRelayByteLimit(resource);
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body.cancel();
        return reject(502);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > limit) {
          await reader.cancel();
          return reject(502);
        }
        chunks.push(next.value);
      }
      const bytes = Buffer.concat(chunks);
      if (resource !== COCHILCO_LIST_PATH && bytes.subarray(0, 5).toString() !== "%PDF-") return reject(502);
      return new Response(bytes, {
        headers: {
          "content-type": resource === COCHILCO_LIST_PATH ? "text/html; charset=utf-8" : "application/pdf",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          [H.sourceUrl]: source,
          [H.bodyHash]: createHash("sha256").update(bytes).digest("hex"),
        },
      });
    } catch {
      return reject(502);
    }
  };
}
