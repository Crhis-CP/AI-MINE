/** Native HTTP transport shared by browser actions and server loaders. Callers own authorization and response schemas. */
export function apiFetch(
  path: string,
  options: RequestInit & {
    baseUrl?: string;
    json?: unknown;
    params?: { path?: Record<string, string | number>; query?: Record<string, unknown> };
    querySerializer?: (query: Record<string, unknown>) => string;
  } = {},
): Promise<Response> {
  const { baseUrl = "", params, querySerializer, json, ...init } = options;
  const pathname = path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = params?.path?.[key];
    if (value === undefined) throw new Error(`Missing API path parameter: ${key}`);
    return encodeURIComponent(String(value));
  });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params?.query ?? {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, String(item));
  }
  const search = (querySerializer ? querySerializer(params?.query ?? {}) : query.toString()).replace(/^\?/, "");
  if (json !== undefined) {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    init.headers = headers;
    init.body = JSON.stringify(json);
  }
  return fetch(`${baseUrl.replace(/\/$/, "")}${pathname}${search ? `${pathname.includes("?") ? "&" : "?"}${search}` : ""}`, init);
}
