import assert from "node:assert/strict";
import { test } from "node:test";
import { switchModel } from "@amp/backend/admin/models";
import { modelPresetReady } from "@amp/backend/providers/llm";

test("model switch rejects an unknown step and a vision mismatch before saving", async () => {
  await assert.rejects(switchModel("not-a-step", "default", "更换处理模型", "admin:1"), (error: { statusCode?: number }) => error.statusCode === 400);
  await assert.rejects(switchModel("prefilter", "default", "  ", "admin:1"), (error: { statusCode?: number }) => error.statusCode === 400);
  await assert.rejects(
    switchModel("prefilter", "qwen3-vl-flash", "这个环节不看图", "admin:1"),
    (error: { statusCode?: number; message?: string }) => error.statusCode === 400 && error.message === "只看图的模型不能用于这个环节",
  );
  if (!modelPresetReady("mimo-v2.6-flash")) {
    await assert.rejects(
      switchModel("summarize", "mimo-v2.6-flash", "切到尚未接入的内置模型", "admin:1"),
      (error: { statusCode?: number; message?: string }) => error.statusCode === 400 && error.message === "这个模型已内置，当前还没有可用的接口，不能切换过去",
    );
  }
});
