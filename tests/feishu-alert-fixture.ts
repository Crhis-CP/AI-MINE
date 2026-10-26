import assert from "node:assert/strict";
import type { TestContext } from "node:test";

/** Exercise the real send result without allowing any external transport. */
export function mockFeishuAlerts(t: TestContext) {
  const keys = ["FEISHU_INTERNAL_ENABLED", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_ALERT_CHAT_ID"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    FEISHU_INTERNAL_ENABLED: "true",
    FEISHU_APP_ID: "synthetic-app",
    FEISHU_APP_SECRET: "synthetic-secret",
    FEISHU_ALERT_CHAT_ID: "synthetic-chat",
  });
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = { fail: false, messages: [] as string[] };
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
      return Response.json({ code: 0, tenant_access_token: "synthetic-token", expire: 7200 });
    assert.equal(String(url), "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", "unexpected transport is forbidden");
    if (state.fail) throw new Error("synthetic delivery outcome unknown");
    const text = JSON.parse(JSON.parse(String(init?.body)).content).text as string;
    state.messages.push(text);
    const [title, ...lines] = text.split("\n");
    console.log(JSON.stringify({ title: title!.replace(/^【[^】]*】/, ""), lines }));
    return Response.json({ code: 0, data: { message_id: `synthetic-${state.messages.length}` } });
  });
  return state;
}
