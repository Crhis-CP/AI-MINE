import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { MCP_TOOLS } from "@amp/contracts/mcp";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = `import {createElement as h} from 'react';import {MCP_TOOL_NAMES as TOOL_NAMES} from '@amp/contracts/mcp';
const marker="test & ' value";
export const WEB_MODULES=typeof window!=='undefined'&&new URLSearchParams(location.search).has('withoutModules')?[]:[{name:'fixture',agentWays:['扩展接入'],agent:async()=>({default:{
  tracks:[{key:'fixture',name:'合成接入',short:'扩展',badge:'合成标签',pitch:'合成说明',fit:'合成客户端',Panel:({tag,now})=>h('p',{'data-testid':'module-panel'},tag+'|'+now)},
    {key:'mcp',name:'不得覆盖核心',short:'不得覆盖',pitch:'',fit:'',Panel:()=>h('p',null,'错误核心')}],
  tag:{useValue:()=>marker,query:'client',userAgent:v=>'fixture/'+v,Note:()=>h('p',null,'合成标识说明'),mcp:'合成MCP说明',rss:'合成RSS说明'},
  Banner:({href,open})=>h('div',null,h('a',{href:href('fixture-rss')},'合成定位链接'),h('button',{onClick:()=>open('fixture-rss')},'打开合成补充')),
  blocks:[{track:'rss',anchor:'fixture-rss',Block:()=>h('p',null,'合成RSS补充')}],
  resources:[['合成资源','/fixture-resource','合成资源说明']],
  guideClients:['FixtureGuide'],tools:[{name:'fixture_tool',does:'合成工具用途',ask:'合成询问'},{name:TOOL_NAMES.latest,does:'不得覆盖工具',ask:'不应出现'}],
  mcpTroubles:[h('span',null,'合成MCP排查')],rssLead:['合成RSS引导'],
  api:{group:'合成接口组',rows:[['/api/fixture','合成接口用途','按需读取']]},
  recipes:[{key:'one',label:'合成示例一',Body:({base,curl})=>h('p',{'data-testid':'recipe'},'one:'+base+'|'+curl)},
    {key:'two',label:'合成示例二',Body:({base,curl})=>h('p',{'data-testid':'recipe'},'two:'+base+'|'+curl)}],
  apiErrors:[['418',h('span',null,'合成错误说明')]]
}})}];`;
const server = await createServer({
  root,
  cacheDir: ".verify/agent-modules-vite",
  configFile: false,
  appType: "custom",
  server: { host: "127.0.0.1", port: 0, hmr: false },
  resolve: { alias: { "@amp/site/modules/web": "\0fixture-agent-modules" } },
  plugins: [
    {
      name: "fixture-agent-modules",
      resolveId: (id) => (id === "\0fixture-agent-modules" || id === "/fixture-agent-entry.ts" ? id : null),
      load: (id) =>
        id === "\0fixture-agent-modules"
          ? fixture
          : id === "/fixture-agent-entry.ts"
            ? `
      import {createElement as h} from 'react';import {createRoot} from 'react-dom/client';
      import {createBrowserRouter,RouterProvider} from 'react-router';
      import Agent from '/apps/web/app/routes/agent.tsx';import More from '/apps/web/app/routes/more.tsx';
      const router=createBrowserRouter([{id:'agent',path:'/agent',element:h(Agent),loader:async()=>{
        if(document.documentElement.hasAttribute('data-hold-loader')) await new Promise(resolve=>document.addEventListener('fixture-release-loader',resolve,{once:true}));
        return {tab:'mcp',healthy:true,base:'https://reader.invalid',now:123456};
      }},{id:'more',path:'/more',element:h(More)}],{hydrationData:{loaderData:{agent:{tab:'mcp',healthy:true,base:'https://reader.invalid',now:123456}}}});
      createRoot(document.getElementById('root')).render(h(RouterProvider,{router}));`
            : null,
      configureServer: (server) => {
        server.middlewares.use((req, res, next) => {
          if (!req.headers.accept?.includes("text/html")) return next();
          // Serve the fixture entry; source modules still use Vite's transformations.
          res.setHeader("content-type", "text/html");
          res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture-agent-entry.ts"></script></body></html>');
        });
      },
    },
  ],
});
await server.listen();
const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
const browser = await chromium.launch({
  executablePath: browserExecutable(),
  headless: true,
  args: ["--disable-background-networking", "--disable-component-update"],
});
after(async () => {
  await browser.close();
  await server.close();
});

test("unknown tabs remain usable and installed tracks, banners, tags and resources work in the browser", { timeout: 30000 }, async () => {
  const context = await browser.newContext();
  const blocked = await isolateBrowser(context, [origin]);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/agent?tab=unknown`);
    await expect(page.getByRole("heading", { name: /加一个地址/ })).toBeVisible();
    await expect(page.getByText("合成标识说明")).toBeVisible();
    await expect(page.getByRole("link", { name: /合成资源/ }).first()).toHaveAttribute("href", "/fixture-resource");
    await page.evaluate(() => document.documentElement.setAttribute("data-hold-loader", ""));
    await page.getByRole("tab", { name: "扩展", exact: true }).click();
    await expect(page.getByTestId("module-panel")).toHaveText("test & ' value|123456");
    await page.evaluate(() => {
      document.documentElement.removeAttribute("data-hold-loader");
      document.dispatchEvent(new Event("fixture-release-loader"));
    });
    await expect(page).toHaveURL(/tab=fixture$/);
    await expect(page.getByText("错误核心")).toHaveCount(0);
    await page.getByRole("button", { name: "打开合成补充" }).click();
    await expect(page).toHaveURL(/tab=rss#fixture-rss$/);
    await expect(page.locator("#fixture-rss")).toContainText("合成RSS补充");
    await expect(page.locator("code").filter({ hasText: "client=" }).first()).toContainText("client=test+%26+%27+value");
    await page.getByRole("tab", { name: "REST API", exact: true }).click();
    await expect(page.locator("code").filter({ hasText: "curl -A" }).first()).toContainText("'\"'\"'");
    await page.goto(`${origin}/more`);
    await expect(page.getByRole("link", { name: /Agent 接入/ })).toContainText("扩展接入");
    // Vite may try its local reload socket; isolation still closes every WebSocket before dispatch.
    assert.ok(
      blocked.every((value) => {
        const url = new URL(value);
        return url.protocol === "ws:" && url.hostname === "127.0.0.1" && [new URL(origin).port, "0"].includes(url.port);
      }),
    );
  } finally {
    await context.close();
  }
});

test("without module providers the existing MCP entry and resources stay available", { timeout: 30000 }, async () => {
  const context = await browser.newContext();
  await isolateBrowser(context, [origin]);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/agent?withoutModules=1`);
    await expect(page.getByRole("heading", { name: /加一个地址/ })).toBeVisible();
    await expect(page.getByText("合成标识说明")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "扩展", exact: true })).toHaveCount(0);
    await expect(page.locator("code").filter({ hasText: "https://reader.invalid/api/mcp" }).first()).toContainText("https://reader.invalid/api/mcp");
  } finally {
    await context.close();
  }
});

test("module guide content includes declared tools, recipes and recovery notes without replacing core tools", { timeout: 30000 }, async () => {
  const context = await browser.newContext();
  await isolateBrowser(context, [origin]);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/agent`);
    await expect(page.getByText("FixtureGuide", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: `加一个地址，Agent 直接调用 ${MCP_TOOLS.length + 1} 个工具`, exact: true })).toBeVisible();
    await expect(page.getByText("fixture_tool", { exact: true })).toBeVisible();
    await expect(page.getByText("不得覆盖工具", { exact: false })).toHaveCount(0);
    await expect(page.getByText("合成MCP排查")).toBeVisible();
    await page.getByRole("tab", { name: "RSS", exact: true }).click();
    await expect(page.getByText("合成RSS引导", { exact: false })).toBeVisible();
    await page.getByRole("tab", { name: "REST API", exact: true }).click();
    await expect(page.getByRole("heading", { name: "合成接口组" })).toBeVisible();
    await expect(page.getByText("/api/fixture", { exact: true })).toBeVisible();
    await expect(page.getByText("按需读取", { exact: false })).toBeVisible();
    await page.getByRole("tab", { name: "合成示例二", exact: true }).click();
    await expect(page.getByTestId("recipe")).toContainText("two:https://reader.invalid|curl -A");
    await expect(page.getByText("合成错误说明")).toBeVisible();
  } finally {
    await context.close();
  }
});
