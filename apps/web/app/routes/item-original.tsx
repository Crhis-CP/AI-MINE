import type { Route } from "./+types/item-original";
import type { SiteItemDetail } from "@amp/contracts/site";
import { XPostDetailFields } from "@amp/contracts/http/public";
import { loadOr404 } from "../lib/api.server";

export { default, headers, meta } from "./item";

export async function loader({ params, request }: Route.LoaderArgs) {
  const item = await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}/original`, { signal: request.signal });
  XPostDetailFields.parse(item.x === undefined ? {} : { x: item.x });
  return { item };
}
