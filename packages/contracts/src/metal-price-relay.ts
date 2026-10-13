import { z } from "zod";

/** Only the already approved Cochilco listing and original daily PDFs may pass this service. */
export const COCHILCO_ORIGIN = "https://www.cochilco.cl";
export const COCHILCO_LIST_PATH = "/web/la-rueda-diaria/";
export const PRICE_RELAY_VERSION = "amp-cochilco-v1";
export const PRICE_RELAY_MAX_AGE_SECONDS = 90;
export const PRICE_RELAY_HEADERS = {
  issuedAt: "x-amp-relay-issued-at",
  signature: "x-amp-relay-signature",
  sourceUrl: "x-amp-source-url",
  bodyHash: "x-amp-source-sha256",
} as const;

export const PriceRelayResource = z
  .string()
  .max(300)
  .refine(
    (value) => value === COCHILCO_LIST_PATH || /^\/web\/download\/\d+\/[a-z]+-\d{4}\/\d+\/rueda-\d{2}-\d{2}-\d{4}\.pdf$/.test(value),
    "Only the approved listing and original daily PDF paths are allowed",
  );
export const PriceRelayRequest = z.strictObject({
  resource: PriceRelayResource,
  issuedAt: z.string().regex(/^[1-9]\d{9,11}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

/** Ed25519 signs these UTF-8 bytes. Keys are not carried in requests; only the public key leaves the server. */
export function priceRelaySigningText(resource: string, issuedAt: string): string {
  PriceRelayResource.parse(resource);
  PriceRelayRequest.shape.issuedAt.parse(issuedAt);
  return JSON.stringify([PRICE_RELAY_VERSION, "GET", resource, issuedAt]);
}

export function priceRelaySourceUrl(resource: string): string {
  return COCHILCO_ORIGIN + PriceRelayResource.parse(resource);
}

export function priceRelayByteLimit(resource: string): number {
  return PriceRelayResource.parse(resource) === COCHILCO_LIST_PATH ? 2 * 1024 * 1024 : 4 * 1024 * 1024;
}
