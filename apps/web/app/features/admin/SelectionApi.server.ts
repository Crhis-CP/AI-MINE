import { apiFetch } from "../../lib/http.ts";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import { adminGet } from "../../lib/admin.server";
import { apiBaseFor } from "../../../api-target";
export async function readSelectionTool(request: Request) {
  const path = "/api/admin/selectbench/control",
    apiBase = apiBaseFor(path);
  return privateSchemas.SelectionToolState.parse(
    await adminGet(request, path, (_url, init) => apiFetch(path, { headers: init.headers, signal: init.signal, method: "GET", baseUrl: apiBase })),
  );
}
export async function readSelectionStandards(request: Request) {
  const path = "/api/admin/selectbench/standards",
    apiBase = apiBaseFor(path);
  return privateSchemas.SelectionStandards.parse(
    await adminGet(request, path, (_url, init) => apiFetch(path, { headers: init.headers, signal: init.signal, method: "GET", baseUrl: apiBase })),
  );
}
export async function readSelectionSamples(request: Request) {
  const path = "/api/admin/selectbench/samples",
    apiBase = apiBaseFor(path),
    url = new URL(request.url),
    query = {
      page: Math.max(1, Number(url.searchParams.get("page") ?? 1)),
      ...(url.searchParams.get("datasetId") ? { datasetId: url.searchParams.get("datasetId")! } : {}),
    };
  return privateSchemas.SelectionSamples.parse(
    await adminGet(request, path, (_url, init) =>
      apiFetch(path, { params: { query }, headers: init.headers, signal: init.signal, method: "GET", baseUrl: apiBase }),
    ),
  );
}
export async function readPrefilterAudit(request: Request) {
  const path = "/api/admin/selectbench/prefilter-audit";
  return privateSchemas.PrefilterAuditView.parse(await adminGet(request, path));
}
export async function readSelectionEvidence(request: Request, id: string) {
  const path = "/api/admin/selectbench/{id}/evidence" as const,
    apiBase = apiBaseFor("/api/admin/selectbench");
  return privateSchemas.SelectionRunEvidence.parse(
    await adminGet(request, `/api/admin/selectbench/${encodeURIComponent(id)}/evidence`, (_url, init) =>
      apiFetch(path, { params: { path: { id } }, headers: init.headers, signal: init.signal, method: "GET", baseUrl: apiBase }),
    ),
  );
}
