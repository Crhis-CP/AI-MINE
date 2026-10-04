/** Generated clients already consume JSON bodies, including error responses. */
export type AdminResult = Response | { response: Response; data?: unknown; error?: unknown };
export type AdminSend = (url: string, init: RequestInit) => Promise<AdminResult>;

export function adminResponse(result: AdminResult): Response {
  return result instanceof Response ? result : result.response;
}

export async function adminBody(result: AdminResult, allowEmpty = false): Promise<unknown> {
  if (!(result instanceof Response)) return result.response.ok ? result.data : result.error;
  if (!allowEmpty) return result.json();
  const text = await result.text();
  return text ? JSON.parse(text) : null;
}
