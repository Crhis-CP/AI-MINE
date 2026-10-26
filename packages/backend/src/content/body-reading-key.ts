import { bodyReaderConfiguration, credential } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";

export const BODY_READER_RECIPE = "body-direct:v2";
/** Only the digest enters audit records; a deployment alone does not buy another attempt. */
export function bodyReadingKey(article: { id: string; revision: number; url: string }, sourceConfig: Record<string, unknown>, permissionVersion: number) {
  const state = bodyReaderConfiguration().state;
  let reader: Array<string | null> = [state];
  try {
    if (state === "configured")
      reader = [state, credential("collectors", "JINA_API_KEY"), (credential("collectors", "JINA_BASE_URL") ?? "https://r.jina.ai").replace(/\/$/, "")];
  } catch {
    reader = ["unavailable"];
  }
  return sha256(stableJson([BODY_READER_RECIPE, article.id, article.revision, article.url, sourceConfig, permissionVersion, reader]));
}
