/** Callers retain the native response until the loader or action reads it once. */
export type AdminSend = (url: string, init: RequestInit) => Promise<Response>;

export async function adminBody(result: Response, allowEmpty = false): Promise<unknown> {
  if (!allowEmpty) return result.json();
  const text = await result.text();
  return text ? JSON.parse(text) : null;
}
