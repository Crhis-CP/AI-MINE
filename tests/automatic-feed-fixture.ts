// SELF_AUTHORED protocol fixtures, not recorded news or model-quality/production evidence.
import { createServer } from "node:http";
import { once } from "node:events";
import { Reply, stub } from "./setup.ts";

export const FEED_CASES = [
  { marker: "AUTO_PASS", title: "合成铜矿选矿试验公告", label: "PASS" },
  { marker: "AUTO_BLOCK", title: "合成独立煤矿生产公告", label: "BLOCK" },
  { marker: "AUTO_UNKNOWN", title: "合成矿企活动信息待核实", label: "UNKNOWN" },
] as const;
export const authoredTitle = (marker: string) => `合成模型处理标题 ${marker}`;
export const authoredSummary = (marker: string) => `合成模型导读 ${marker}：仅用于验证自动处理接口，不代表真实新闻或质量评价。`;

/** Real loopback HTTP at both boundaries; the worker still parses RSS and invokes its model adapter. */
export async function automaticFeedFixture() {
  const feedRequests: string[] = [];
  const calls: { marker: string; step: string; user: string }[] = [];
  const feed = createServer((req, res) => {
    feedRequests.push(req.url ?? "");
    if (req.url !== "/feed.xml") {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader("content-type", "application/rss+xml; charset=utf-8");
    res.end(
      '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>' +
        FEED_CASES.map(({ marker, title }) => {
          const body = `${marker}：${title}。这段材料是自编采集夹具，只验证接口、正文保存和范围状态的传播，不是生产内容。`.repeat(6);
          return (
            `<item><title>${title} ${marker}</title><link>https://example.invalid/${marker}</link>` +
            `<pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate><content:encoded><![CDATA[<p>${body}</p>]]></content:encoded></item>`
          );
        }).join("") +
        "</channel></rss>",
    );
  });
  feed.listen(0, "127.0.0.1");
  await once(feed, "listening");
  const closeFeed = () =>
    new Promise<void>((resolve) => {
      feed.closeAllConnections();
      feed.close(() => resolve());
    });
  try {
    const provider = await stub((_hit, req) => {
      const body = JSON.parse(req.body) as { messages: { role: string; content: string }[] };
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const user = body.messages.at(-1)!.content;
      const sample = FEED_CASES.find(({ marker }) => user.includes(marker));
      const step = system.includes("范围预筛")
        ? "prefilter"
        : system.includes("事件注意力评分器")
          ? "score"
          : system.includes("资料结构化助手")
            ? "structure"
            : !system
              ? "summarize"
              : "unexpected";
      calls.push({ marker: sample?.marker ?? "missing", step, user });
      if (!sample || step === "unexpected" || req.url !== "/v1/chat/completions") return new Reply(400, { error: "unexpected fixture request" });
      const result =
        step === "prefilter"
          ? { label: sample.label, reason: "合成预筛结果，不评价模型分类质量" }
          : step === "score"
            ? { attentionScore: 10 }
            : step === "structure"
              ? { category: null, tags: [], subjects: [], fact: null }
              : `title_zh: ${authoredTitle(sample.marker)}\nsummary_zh: ${authoredSummary(sample.marker)}`;
      return {
        id: `fixture-${calls.length}`,
        choices: [{ message: { content: typeof result === "string" ? result : JSON.stringify(result) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    });
    return {
      feedUrl: `http://127.0.0.1:${(feed.address() as { port: number }).port}/feed.xml`,
      providerUrl: provider.url,
      feedRequests,
      calls,
      async close() {
        await provider.close();
        await closeFeed();
      },
    };
  } catch (error) {
    await closeFeed();
    throw error;
  }
}
