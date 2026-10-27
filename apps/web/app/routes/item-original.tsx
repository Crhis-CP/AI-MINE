import type { Route } from "./+types/item-original";
import { XPostDetailFields, ReportGroupDetailFields } from "@amp/contracts/http/public";
import type { ReportGroupedSiteItemDetail as SiteItemDetail } from "@amp/contracts/site";
import { apiGet, loadOr404 } from "../lib/api.server";

export { default, headers, meta } from "./item";

export async function loader({ params, request }: Route.LoaderArgs) {
  const item = await loadOr404(
    async () => {
      const value = await apiGet<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}/original?readingGroups=reports-v1`, {
        signal: request.signal,
      });
      XPostDetailFields.parse(value.x === undefined ? {} : { x: value.x });
      return { ...value, ...ReportGroupDetailFields.parse(value.reportGroup === undefined ? {} : { reportGroup: value.reportGroup }) };
    },
    { signal: request.signal },
  );
  return { item };
}
