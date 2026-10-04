// Admin loaders read /api/admin/* with the visitor's own cookie; the web process holds no session.
import { data, redirect } from "react-router";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import type { z } from "zod";

import { apiBaseFor, privateHostHeaders } from "../../api-target.ts";
import { adminBody, adminResponse, type AdminSend } from "./admin-response.ts";

export async function adminGet<T>(request: Request, path: string, send: AdminSend = fetch): Promise<T> {
  const result = await send(`${apiBaseFor(path)}${path}`, {
    headers: {
      accept: "application/json",
      cookie: request.headers.get("cookie") ?? "",
      "user-agent": request.headers.get("user-agent") ?? "",
      ...privateHostHeaders(path, request.headers.get("host")),
    },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
  });
  const res = adminResponse(result);
  if (res.status === 401) {
    const url = new URL(request.url);
    throw redirect(`/admin/login?${new URLSearchParams({ return: url.pathname + url.search })}`);
  }
  if (res.status === 404) throw data({ message: "not_found" }, { status: 404 });
  if (!res.ok) {
    let detail = `api ${res.status}`;
    try {
      detail = ((await adminBody(result)) as { detail?: string }).detail ?? detail;
    } catch {
      // not JSON
    }
    throw data({ message: detail }, { status: res.status >= 500 ? 503 : res.status });
  }
  return (await adminBody(result)) as T;
}

type Reconciliation = Pick<z.infer<typeof privateSchemas.ReceiptReconciliationResponse>, "receipts" | "deliveries">;

/** The unchanged legacy monitor fields remain untyped here; the reconciliation subset is checked. */
export async function loadReconciliation<T extends Reconciliation = Reconciliation>(request: Request): Promise<T> {
  const path = "/api/admin/runs";
  const client = createPrivateClient({ baseUrl: apiBaseFor(path) });
  const body = await adminGet<T>(request, path, (_url, init) => client.GET(path, { headers: init.headers, signal: init.signal }));
  privateSchemas.ReceiptReconciliationResponse.parse(body);
  return body;
}
