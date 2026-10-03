import { createServer } from "node:http";

/** Local synthetic fixture only; not the acquisition FetchPort wire contract. */
export interface Recording {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function createFetcher(recordings: ReadonlyMap<string, Recording> = new Map()) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (req, res) => {
    const error = (status: number, code: string) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ code }));
    };
    if (req.url !== "/fetch") return error(404, "not_found");
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return error(405, "method_not_allowed");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("error", () => error(400, "invalid_request"));
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16_384) return error(413, "request_too_large");
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded || res.destroyed) return;
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return error(400, "invalid_json");
      }
      if (!input || typeof input !== "object" || !("url" in input) || typeof input.url !== "string" || !input.url.trim()) {
        return error(400, "invalid_request");
      }
      const recorded = recordings.get(input.url);
      if (!recorded) return error(404, "not_recorded");
      res.writeHead(recorded.status, recorded.headers);
      res.end(recorded.body);
    });
  });
}
