import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Node fetch ignores a supplied Host; HTTP boundary probes need the authority actually sent on the wire. */
export function fetchWithHost(address: string, host: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<Response>((resolve, reject) => {
    const url = new URL(address);
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: init.method, headers: { ...init.headers, host }, signal: AbortSignal.timeout(30_000) },
      (res) => {
        const headers = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        const status = res.statusCode ?? 502;
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) req.destroy(new Error("HTTP probe response exceeds 8 MiB"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const body = init.method === "HEAD" || status === 204 || status === 304 ? null : new Uint8Array(Buffer.concat(chunks));
          resolve(new Response(body, { status, headers }));
        });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}
