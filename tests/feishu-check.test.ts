// The Feishu connection check (TASK-0062): it reads the settings, lists the chats the message app's bot is in
// and says in plain words what is missing; --send sends one test message to the alert chat. Feishu is answered
// here: only its token, list-chats and send-message endpoints, any other request fails the test. Neither the
// App Secret nor the tenant token ever appears in what the check prints or logs.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { main } from "../scripts/feishu-check.ts";

const SECRET = "test-secret";
const TOKEN = "t-test-token";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  auth: string | null;
}
type Answer = Record<string, unknown>;

let calls: Call[] = [];
let stray: string[] = [];
let tokenAnswer: () => Answer;
let chatsAnswer: (pageToken: string | null) => Answer;

const TWO_PAGES = (pageToken: string | null): Answer =>
  pageToken === "p2"
    ? { code: 0, data: { items: [{ chat_id: "oc_feedback_test", name: "读者反馈" }], has_more: false } }
    : {
        code: 0,
        data: {
          items: [
            { chat_id: "oc_alert_test", name: "运行提醒" },
            { chat_id: "oc_other_test", name: "别的群" },
          ],
          has_more: true,
          page_token: "p2",
        },
      };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.hostname !== "open.feishu.cn") {
    stray.push(`${method} ${url.href}`);
    throw new Error(`unexpected request ${url.href}`);
  }
  calls.push({
    method,
    path: url.pathname,
    query: url.searchParams,
    body: typeof init?.body === "string" ? init.body : "",
    auth: new Headers(init?.headers).get("authorization"),
  });
  if (method === "POST" && url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") return Response.json(tokenAnswer());
  if (method === "GET" && url.pathname === "/open-apis/im/v1/chats") return Response.json(chatsAnswer(url.searchParams.get("page_token")));
  if (method === "POST" && url.pathname === "/open-apis/im/v1/messages") return Response.json({ code: 0, data: { message_id: "om_test" } });
  stray.push(`${method} ${url.href}`);
  throw new Error(`unexpected Feishu request ${method} ${url.pathname}`);
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  stray = [];
  tokenAnswer = () => ({ code: 0, tenant_access_token: TOKEN, expire: 7200 });
  chatsAnswer = TWO_PAGES;
  settings();
});

afterEach(() => {
  assert.deepEqual(stray, [], "only Feishu's token, list-chats and send-message endpoints are called");
});

/** Everything filled in, with `changes` applied (undefined removes a setting). */
function settings(changes: Record<string, string | undefined> = {}) {
  const all: Record<string, string | undefined> = {
    FEISHU_INTERNAL_ENABLED: "true",
    FEISHU_APP_ID: "test-app",
    FEISHU_APP_SECRET: SECRET,
    FEISHU_ALERT_CHAT_ID: "oc_alert_test",
    FEISHU_INTERNAL_CHAT_ID: "oc_feedback_test",
    ...changes,
  };
  for (const [name, value] of Object.entries(all)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Runs the check, capturing what it prints and anything it logs. */
async function check(argv: string[] = []): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const logged: string[] = [];
  const { log, error, warn } = console;
  console.log = console.error = console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const code = await main(argv, (line) => lines.push(line));
    const out = lines.join("\n");
    for (const text of [out, logged.join("\n")]) {
      assert.ok(!text.includes(SECRET), "the App Secret is never printed or logged");
      assert.ok(!text.includes(TOKEN), "the tenant token is never printed or logged");
    }
    return { code, out };
  } finally {
    Object.assign(console, { log, error, warn });
  }
}

const sent = () => calls.filter((c) => c.method === "POST" && c.path === "/open-apis/im/v1/messages");

// The token is cached for the rest of the process once Feishu hands one out, so the cases that must not get one
// (missing settings, a refused token) come first.

test("an unknown argument prints the usage and fails", async () => {
  const { code, out } = await check(["--bogus"]);
  assert.notEqual(code, 0);
  assert.match(out, /用法：node scripts\/feishu-check\.ts \[--send\]/);
  assert.equal(calls.length, 0);
});

test("without the App Secret it asks for it and sends nothing", async () => {
  settings({ FEISHU_APP_SECRET: undefined });
  const { code, out } = await check();
  assert.notEqual(code, 0);
  assert.match(out, /App ID 已填，App Secret 没填/);
  assert.match(out, /先经安全录入填好/);
  assert.equal(calls.length, 0, "no request leaves the process");
});

test("a token Feishu refuses is a failure in one plain sentence", async () => {
  tokenAnswer = () => ({ code: 10014, msg: "app secret invalid" });
  const { code, out } = await check();
  assert.notEqual(code, 0);
  assert.match(out, /取令牌：飞书没有接受这对应用凭据。飞书的说明：app secret invalid/);
  assert.equal(calls.filter((c) => c.path === "/open-apis/im/v1/chats").length, 0);
});

test("with everything set it lists both pages of chats and passes", async () => {
  const { code, out } = await check();
  assert.equal(code, 0, out);
  assert.match(out, /提醒开关：开着/);
  assert.match(out, /应用凭据：App ID 已填，App Secret 已填/);
  assert.match(out, /机器人所在的群（3 个）/);
  for (const chat of ["运行提醒（oc_alert_test）", "别的群（oc_other_test）", "读者反馈（oc_feedback_test）"]) assert.ok(out.includes(chat), chat);
  assert.match(out, /提醒群：运行提醒（oc_alert_test），机器人在群里/);
  assert.match(out, /反馈群：读者反馈（oc_feedback_test），机器人在群里/);
  assert.match(out, /结论：通过/);
  const lists = calls.filter((c) => c.path === "/open-apis/im/v1/chats");
  assert.deepEqual(
    lists.map((c) => c.query.get("page_token")),
    [null, "p2"],
    "the second page is asked for with Feishu's page token",
  );
  assert.ok(lists.every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.equal(sent().length, 0, "nothing is sent without --send");
});

test("a switch written as 1 is off: it only accepts true", async () => {
  settings({ FEISHU_INTERNAL_ENABLED: "1" });
  const { code, out } = await check();
  assert.notEqual(code, 0);
  assert.match(out, /写的是“1”。开关只认 true，现在等于关着/);
});

test("Feishu refusing the chat list (no permission) is a failure in one plain sentence", async () => {
  chatsAnswer = () => ({ code: 99991672, msg: "Access denied. One of the following scopes is required: [im:chat:readonly]" });
  const { code, out } = await check();
  assert.notEqual(code, 0);
  assert.match(out, /列不出机器人所在的群。多半是应用还没开“获取群组信息”权限/);
  assert.match(out, /飞书的说明：99991672 Access denied/);
});

test("an alert chat the bot is not in fails", async () => {
  settings({ FEISHU_ALERT_CHAT_ID: "oc_missing_test" });
  const { code, out } = await check();
  assert.notEqual(code, 0);
  assert.match(out, /提醒群：群号 oc_missing_test 不在机器人所在的群里。先把机器人拉进群，或改正群号/);
});

test("no feedback chat is normal: reader feedback is simply not forwarded", async () => {
  settings({ FEISHU_INTERNAL_CHAT_ID: undefined });
  const { code, out } = await check();
  assert.equal(code, 0, out);
  assert.match(out, /反馈群：没填，读者反馈不转发到飞书/);
});

test("the same chat for alerts and feedback is only a hint", async () => {
  settings({ FEISHU_INTERNAL_CHAT_ID: "oc_alert_test" });
  const { code, out } = await check();
  assert.equal(code, 0, out);
  assert.match(out, /提醒群和反馈群是同一个群；反馈里有读者的联系方式和截图，建议分开/);
});

test("--send sends exactly one test message to the alert chat", async () => {
  const { code, out } = await check(["--send"]);
  assert.equal(code, 0, out);
  assert.match(out, /已发到提醒群，请在飞书里看一眼/);
  const messages = sent();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.query.get("receive_id_type"), "chat_id");
  const body = JSON.parse(messages[0]!.body) as { receive_id: string; content: string };
  assert.equal(body.receive_id, "oc_alert_test");
  assert.ok((JSON.parse(body.content) as { text: string }).text.includes("【测试】运行提醒已接通"));
});

test("--send with the switch off sends nothing and fails", async () => {
  settings({ FEISHU_INTERNAL_ENABLED: "false" });
  const { code, out } = await check(["--send"]);
  assert.notEqual(code, 0);
  assert.match(out, /--send：开关没开，什么也没发/);
  assert.equal(sent().length, 0);
});
