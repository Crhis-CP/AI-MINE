import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { COCHILCO_ORIGIN, PRICE_RELAY_HEADERS as H, priceRelaySigningText, priceRelayByteLimit, priceRelaySourceUrl } from "@amp/contracts/metal-price-relay";
import { config } from "@amp/backend/config";
import { guardedFetch, type GuardedFetchOptions, type GuardedResponse } from "@amp/backend/lib/http-fetch";

/** What the Cochilco requests depend on; production reads the worker's configuration, tests pass their own. */
export interface CochilcoRoute {
  relayUrl: string | null;
  keyFile: string;
  get: typeof guardedFetch;
  readKey: (file: string) => string;
}
const configured = (): CochilcoRoute => ({
  relayUrl: config.metalPriceRelayUrl,
  keyFile: config.metalPriceRelayKeyFile,
  get: guardedFetch,
  readKey: (file) => readFileSync(file, "utf8"),
});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A Cochilco page or daily PDF, through the signed overseas relay when one is configured, else directly. A failure says
 * which way was taken and what to check, so a run record or alert can be acted on without reading this code.
 */
export async function fetchCochilco(url: string, options: GuardedFetchOptions = {}, route: CochilcoRoute = configured()): Promise<GuardedResponse> {
  if (!route.relayUrl) {
    try {
      return await route.get(url, options);
    } catch (error) {
      throw new Error(`直连 Cochilco 失败（本机没有配置海外取件服务 METAL_PRICE_RELAY_URL）：${message(error)}`);
    }
  }
  let key: string;
  try {
    key = route.readKey(route.keyFile);
  } catch (error) {
    throw new Error(`已配置海外取件服务，但读不到签名私钥 ${route.keyFile}：${(error as { code?: string }).code ?? message(error)}`);
  }
  return fetchThroughPriceRelay(url, route.relayUrl, key, route.get);
}

/** Why the relay's answer was not taken, by its status: the relay itself only says “Request unavailable”. */
function relayStatus(status: number): string {
  if (status === 403) return "取件服务拒绝了签名（HTTP 403）：核对本机时钟（允许前后 90 秒）以及取件服务里的公钥是否与本机私钥配对";
  if (status === 502) return "取件服务没取到 Cochilco 原件（HTTP 502）：官方网站不可达、发生跳转，或文件不是限定大小的 PDF";
  if (status === 400 || status === 405) return `取件服务不接受这个请求（HTTP ${status}）：核对取件服务与本程序的版本是否一致`;
  return `取件服务返回 HTTP ${status}：服务可能停用、超出免费额度或地址有误`;
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
  let response: GuardedResponse;
  try {
    response = await get(relay.href, {
      maxBytes: priceRelayByteLimit(source.pathname),
      maxRedirects: 0,
      followRedirects: false,
      timeoutMs: 35_000,
      // A dropped connection is asked once more within the signature's 90-second window.
      retryDropped: true,
      headers: { [H.issuedAt]: issuedAt, [H.signature]: sign(null, Buffer.from(priceRelaySigningText(source.pathname, issuedAt)), key).toString("base64url") },
    });
  } catch (error) {
    throw new Error(`连不上海外取件服务 ${relay.host}：${message(error)}`);
  }
  if (response.status !== 200) throw new Error(relayStatus(response.status));
  if (
    response.url !== relay.href ||
    response.headers.get(H.sourceUrl) !== url ||
    response.headers.get(H.bodyHash) !== createHash("sha256").update(response.body).digest("hex")
  )
    throw new Error("取件服务的回应与原件核对不上（地址或摘要不符），不采用");
  return { ...response, url };
}
