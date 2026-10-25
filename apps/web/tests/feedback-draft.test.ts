import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { KEYS } from "../app/lib/local-state.ts";

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { alias: { "@amp/site/modules/web": "\0fixture-feedback-drafts" } },
  plugins: [
    {
      name: "fixture-feedback-drafts",
      resolveId: (id) => (id === "\0fixture-feedback-drafts" ? id : null),
      load: (id) => (id === "\0fixture-feedback-drafts" ? "export const WEB_MODULES=[];" : null),
    },
  ],
});
const { WEB_MODULES } = await server.ssrLoadModule("\0fixture-feedback-drafts");
const { readDraft, writeDraft } = await server.ssrLoadModule(fileURLToPath(new URL("../app/lib/feedback-draft.ts", import.meta.url)));
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
after(async () => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  await server.close();
});
const draft = {
  content: "待处理的草稿",
  email: "",
  pageUrl: "/all?q=铜",
  submission: { key: "12345678-1234-4234-8234-123456789012", signature: "original-input" },
};

test("the existing draft wins and unknown-response submission identity survives module fallback", () => {
  const values = new Map<string, string>([[KEYS.feedbackDraft, JSON.stringify(draft)]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null } });
  let reads = 0;
  WEB_MODULES.splice(0, WEB_MODULES.length, {
    name: "unread",
    feedbackDraft: {
      read: () => {
        reads++;
        return draft;
      },
      clear: () => {},
    },
  });
  assert.deepEqual(readDraft(), draft);
  assert.equal(reads, 0);
  values.clear();
  WEB_MODULES.unshift({
    name: "failed",
    feedbackDraft: {
      read: () => {
        throw Error("fixture unavailable");
      },
      clear: () => {},
    },
  });
  assert.deepEqual(readDraft(), draft);
  assert.equal(reads, 1);
});

test("storage refusal keeps module drafts until a successful save or confirmed submission", () => {
  let denied = true,
    cleared = 0;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => {
        throw Error("storage unavailable");
      },
      setItem: (key: string, value: string) => {
        if (denied) throw Error("quota");
        values.set(key, value);
      },
      removeItem: (key: string) => {
        if (denied) throw Error("quota");
        values.delete(key);
      },
    },
  });
  WEB_MODULES.splice(
    0,
    WEB_MODULES.length,
    {
      name: "bad-cleanup",
      feedbackDraft: {
        read: () => null,
        clear: () => {
          throw Error("cleanup unavailable");
        },
      },
    },
    {
      name: "copy",
      feedbackDraft: {
        read: () => draft,
        clear: () => {
          cleared++;
        },
      },
    },
  );
  assert.deepEqual(readDraft(), draft);
  assert.equal(writeDraft(draft), false);
  assert.equal(writeDraft(null), false);
  assert.equal(cleared, 0);
  denied = false;
  assert.equal(writeDraft(draft), true);
  assert.equal(cleared, 1);
  assert.deepEqual(JSON.parse(values.get(KEYS.feedbackDraft)!).submission, draft.submission);
  denied = true;
  assert.equal(writeDraft(null, true), false);
  assert.equal(cleared, 2);
});
