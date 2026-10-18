// Read-only interoperability probe using the official client. Empty collections are reported separately.
// node scripts/mcp-check.ts [url]
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_TOOL_NAMES as T } from "@amp/contracts/mcp";

type Result = { tool: string; state: "passed" | "no_public_sample" };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const items = (value: Record<string, unknown>) => (Array.isArray(value.items) ? value.items.map(object) : []);

export async function checkMcp(url: URL, requestInit?: RequestInit): Promise<Result[]> {
  const client = new Client({ name: "amp-mcp-check", version: "2.0.0" });
  const results: Result[] = [];
  const check = async (name: string, args: Record<string, unknown> = {}, allowMissing = false) => {
    const response = await client.callTool({ name, arguments: args }, { timeout: 15000 });
    const data = object(response.structuredContent);
    if (response.isError) {
      if (allowMissing && object(data.error).code === "not_found") {
        results.push({ tool: name, state: "no_public_sample" });
        return {};
      }
      const detail = response.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join(" ")
        .slice(0, 300);
      throw new Error(`${name} failed: ${String(object(data.error).code ?? "tool_error")} ${detail}`);
    }
    assert.ok(
      response.content.some((entry) => entry.type === "text" && entry.text.trim()),
      `${name}: missing text answer`,
    );
    assert.ok(response.structuredContent, `${name}: missing structured answer`);
    results.push({ tool: name, state: "passed" });
    return data;
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }), { timeout: 15000 });
    const available = new Set((await client.listTools({}, { timeout: 15000 })).tools.map((tool) => tool.name));
    for (const name of Object.values(T)) assert.ok(available.has(name), `Missing public tool: ${name}`);
    const latest = await check(T.latest, { mode: "all", window: "7d", limit: 2 });
    await check(T.search, { q: "铜矿", limit: 2 });
    const hot = await check(T.hot, { limit: 1 });
    await check(T.daily, {}, true);
    for (const kind of ["daily", "weekly", "monthly"]) await check(T.report, { kind }, true);
    await check(T.topics, { limit: 2 });
    const policies = await check(T.policies, { limit: 1 });
    const articleId = items(latest).find((item) => typeof item.id === "string")?.id;
    if (articleId) await check(T.item, { id: articleId });
    else results.push({ tool: T.item, state: "no_public_sample" });
    const story = object(items(hot)[0]?.links).story;
    if (typeof story === "string") {
      const id = new URL(story, url).pathname.split("/").filter(Boolean).at(-1);
      assert.ok(id, "Hot topic has no public story ID");
      await check(T.story, { public_id: id, report_limit: 3 });
    } else results.push({ tool: T.story, state: "no_public_sample" });
    const policyId = items(policies).find((item) => typeof item.id === "string")?.id;
    if (policyId) await check(T.policy, { id: policyId });
    else results.push({ tool: T.policy, state: "no_public_sample" });
    // The legacy policy payload does not advertise thread IDs; never invent one from a title or date.
    results.push({ tool: T.policyThread, state: "no_public_sample" });
    return results;
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  for (const result of await checkMcp(new URL(process.argv[2] ?? "http://127.0.0.1:3001/api/mcp"))) console.log(JSON.stringify(result));
}
