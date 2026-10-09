import assert from "node:assert/strict";
import { test } from "node:test";
import { switchModel } from "@amp/backend/admin/models";

test("model switch rejects an unknown step and a vision mismatch before saving", async () => {
  await assert.rejects(switchModel("not-a-step", "default", "更换处理模型", "admin:1"), (error: { statusCode?: number }) => error.statusCode === 400);
  await assert.rejects(switchModel("prefilter", "default", "  ", "admin:1"), (error: { statusCode?: number }) => error.statusCode === 400);
  await assert.rejects(
    switchModel("prefilter", "qwen3-vl-flash", "这个环节不看图", "admin:1"),
    (error: { statusCode?: number; message?: string }) => error.statusCode === 400 && error.message === "只看图的模型不能用于这个环节",
  );
});
