// The only place the rewritten reader builds an API request. Reads go to the api over loopback like the old pages
// (app/lib/api.server.ts, which this reuses for failure mapping and the response check), so the API sees the same
// headers and a reader's closed tab cancels the read.
import { apiBaseFor } from "../../api-target.ts";
import { contractResult, loadOr404 } from "../../app/lib/api.server.ts";
import { apiFetch } from "../../app/lib/http.ts";

type Query = Record<string, string | number | null | undefined>;

/**
 * One public read, checked against its response schema. A missing record answers the page with 404 and any other
 * failure with 503 (loadOr404); `upstream` carries the API's cache deadline into the page's own (readerPageHeaders).
 */
export async function readSite<T>(
  request: Request,
  path: string,
  schema: { parse(value: unknown): T },
  query: Query = {},
): Promise<{ body: T; upstream: Headers }> {
  return loadOr404(
    async () => {
      const result = await apiFetch(path, {
        params: { query },
        headers: { accept: "application/json", "x-amp-ssr": "1" },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        baseUrl: apiBaseFor(),
      });
      return { body: await contractResult(result, schema), upstream: result.headers };
    },
    { signal: request.signal },
  );
}
