import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import type { SearchSuggestions } from "@amp/contracts/site";
let pending: Promise<SearchSuggestions> | null = null;
/** Share only an ongoing request; successful results are not kept in an application cache. */
export function loadSearchNavigation(): Promise<SearchSuggestions> {
  pending ??= createPublicClient({ baseUrl: window.location.origin })
    .GET("/api/site/search/suggestions", { signal: AbortSignal.timeout(10_000) })
    .then((result) => {
      if (!result.response.ok) throw new Error("Search navigation is unavailable");
      return publicSchemas.SearchSuggestions.parse(result.data);
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
