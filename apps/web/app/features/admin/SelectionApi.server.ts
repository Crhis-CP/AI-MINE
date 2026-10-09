import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import { adminGet } from "../../lib/admin.server";
import { apiBaseFor } from "../../../api-target";
export async function readSelectionTool(request: Request) {
  const path = "/api/admin/selectbench/control",
    client = createPrivateClient({ baseUrl: apiBaseFor(path) });
  return privateSchemas.SelectionToolState.parse(
    await adminGet(request, path, (_url, init) => client.GET(path, { headers: init.headers, signal: init.signal })),
  );
}
export async function readSelectionStandards(request: Request) {
  const path = "/api/admin/selectbench/standards",
    client = createPrivateClient({ baseUrl: apiBaseFor(path) });
  return privateSchemas.SelectionStandards.parse(
    await adminGet(request, path, (_url, init) => client.GET(path, { headers: init.headers, signal: init.signal })),
  );
}
export async function readSelectionSamples(request: Request) {
  const path = "/api/admin/selectbench/samples",
    client = createPrivateClient({ baseUrl: apiBaseFor(path) }),
    url = new URL(request.url),
    query = {
      page: Math.max(1, Number(url.searchParams.get("page") ?? 1)),
      ...(url.searchParams.get("datasetId") ? { datasetId: url.searchParams.get("datasetId")! } : {}),
    };
  return privateSchemas.SelectionSamples.parse(
    await adminGet(request, path, (_url, init) => client.GET(path, { params: { query }, headers: init.headers, signal: init.signal })),
  );
}
export async function readSelectionEvidence(request: Request, id: string) {
  const path = "/api/admin/selectbench/{id}/evidence" as const,
    client = createPrivateClient({ baseUrl: apiBaseFor("/api/admin/selectbench") });
  return privateSchemas.SelectionRunEvidence.parse(
    await adminGet(request, `/api/admin/selectbench/${encodeURIComponent(id)}/evidence`, (_url, init) =>
      client.GET(path, { params: { path: { id } }, headers: init.headers, signal: init.signal }),
    ),
  );
}
