import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { defineServerModule, emit, installModules, requestNotice, type ServerModule } from "../../../packages/backend/src/modules.ts";
import type { FastifyRequest } from "fastify";
import type { Db } from "../../../packages/backend/src/db.ts";
import { defineWebModule, type WebModule } from "../../../apps/web/modules.ts";
import type { ModuleNavigationCounts, ModuleTopicSummary } from "@amp/contracts/modules";

test("module dispatch preserves order, caller context and first applicable notice; failures propagate", async () => {
  const calls: string[] = [];
  const tx = {} as Db,
    req = {} as FastifyRequest;
  try {
    installModules([
      {
        name: "first",
        on: {
          reportsChanged: async (change, db) => {
            assert.equal(db, tx);
            calls.push(change.reason);
          },
        },
        notices: { json: () => null, agent: () => "" },
      },
      {
        name: "second",
        on: {
          reportsChanged: async () => {
            throw new Error("stop transaction");
          },
        },
        notices: {
          agent: () => "second reminder",
          json: (request) => {
            assert.equal(request, req);
            return { notice: { text: "second" }, private: true };
          },
        },
      },
      {
        name: "third",
        on: {
          reportsChanged: async () => {
            calls.push("unexpected");
          },
        },
        notices: {
          json: () => {
            throw new Error("later notice");
          },
        },
      },
    ]);
    assert.deepEqual(requestNotice("json", req), { notice: { text: "second" }, private: true });
    assert.equal(requestNotice("agent", req), "second reminder", "empty reminders defer to the next module, matching the upstream contract");
    await assert.rejects(emit("reportsChanged", { reason: "published" }, tx), /stop transaction/);
    assert.deepEqual(calls, ["published"]);
  } finally {
    installModules([]);
  }
  await emit("reportsChanged", { reason: "no extensions" }, tx);
  assert.equal(requestNotice("json", req), null);
});

test("legacy modules and optional extension hooks remain declarations without executing work", () => {
  let calls = 0;
  const legacy = defineServerModule({ name: "legacy", on: { materialDiscovered: async () => true }, admin: { http: () => {} } });
  const module = {
    name: "extension",
    models: { additional: { label: "合成步骤", env: "SYNTHETIC_MODEL", purposes: ["synthetic"] } },
    alerts: async () => {
      calls++;
      return [];
    },
    retention: async () => {
      calls++;
      return { removed: 0 };
    },
    on: {
      reportsChanged: async () => {
        calls++;
      },
    },
    notices: { json: () => ({ notice: { text: "Synthetic notice" }, private: true }) },
    agent: {
      abilities: [
        {
          path: "/synthetic",
          title: "合成入口",
          ask: "合成查询",
          answer: async () => "synthetic",
          etagPrefix: "synthetic",
          cacheControl: "no-store",
          mcp: { tool: "synthetic", use: "synthetic", description: "synthetic", input: z.object({}), run: async () => ({ text: "synthetic", structured: {} }) },
        },
      ],
    },
    topics: { page: { read: () => ({ recheck: ["synthetic-id"], part: (current) => current.get("synthetic-id") ?? null }) } },
  } satisfies ServerModule;
  assert.equal(defineServerModule(module), module);
  assert.equal(calls, 0, "registering optional metadata must not collect, send, or call models");
  assert.equal(legacy.name, "legacy");
  const invalid: ServerModule = {
    name: "invalid",
    // @ts-expect-error An alert hook must return a promise of findings.
    alerts: () => [],
  };
  assert.ok(invalid);
});

test("web parts stay lazy while legacy navigation and named counter keys remain compatible", () => {
  let loads = 0;
  const module = {
    name: "extension",
    navigation: [{ to: "/synthetic", label: "合成页面", icon: () => null }],
    admin: {
      groups: [{ group: "扩展", items: [{ to: "/admin/synthetic", label: "合成管理", count: "synthetic.pending" }] }],
      runs: async () => {
        loads++;
        return { default: () => null };
      },
    },
    agent: async () => {
      loads++;
      return { default: { resources: [["合成入口", "/synthetic", "合成测试"]] } };
    },
    topicPage: async () => {
      loads++;
      return { default: { name: "合成主题", shows: () => false, Block: () => null, entries: () => [], news: () => [] } };
    },
  } satisfies WebModule;
  assert.equal(defineWebModule(module), module);
  const counts: ModuleNavigationCounts = { sources: 2, "synthetic.pending": 3 };
  assert.equal(counts[module.admin.groups[0].items[0].count], 3);
  assert.equal(loads, 0);
  const topic: ModuleTopicSummary = {
    slug: "mine",
    name: "矿山",
    group: "project",
    definition: "测试项目",
    total: 0,
    recent: 0,
    indexable: false,
    latestAt: null,
    basis: "all",
  };
  assert.equal(topic.group, "project", "the mining-specific project dimension is preserved");
  const invalid: WebModule = {
    name: "invalid",
    // @ts-expect-error A page part must be a lazy promise, not a component instance.
    topicPage: () => null,
  };
  assert.ok(invalid);
});
