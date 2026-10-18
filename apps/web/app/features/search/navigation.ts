import { apiFetch } from "../../lib/http.ts";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import type { SearchSuggestions } from "@amp/contracts/site";
let pending: Promise<SearchSuggestions> | null = null;
/** Share only an ongoing request; successful results are not kept in an application cache. */
export function loadSearchNavigation(): Promise<SearchSuggestions> {
  pending ??= apiFetch("/api/site/search/suggestions", { signal: AbortSignal.timeout(10_000), baseUrl: window.location.origin })
    .then(async (result) => {
      if (!result.ok) throw new Error("Search navigation is unavailable");
      return publicSchemas.SearchSuggestions.parse(await result.json());
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
