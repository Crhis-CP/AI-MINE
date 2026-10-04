import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkWebSplit } from "../web-split.ts";

test("split output proof rejects private routes, dependencies and every text asset kind", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "amp-web-split-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, text: string) => {
    const target = path.join(root, "apps/web/build", file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const manifest = (routes: Record<string, unknown>) => `window.__reactRouterManifest=${JSON.stringify({ routes })};`;
  write("public/client/assets/manifest-public.js", manifest({ root: {}, "public-layout": {} }));
  write("private/client/assets/manifest-private.js", manifest({ root: {}, "routes/admin-login": {} }));
  write("public/modules.json", '["app/root.tsx"]');
  assert.deepEqual(checkWebSplit(root), []);
  write("public/modules.json", '["app/features/admin/toast.tsx"]');
  assert.match(checkWebSplit(root).join("\n"), /module graph/);
  write("public/modules.json", '["app/root.tsx"]');
  for (const extension of ["js", "css", "map", "json", "html"]) {
    write(`public/client/probe.${extension}`, '"routes/admin-login"');
    assert.match(checkWebSplit(root).join("\n"), /public asset/);
    write(`public/client/probe.${extension}`, "{}");
  }
  write("public/client/assets/manifest-public.js", manifest({ root: {}, "public-layout": {}, "routes/admin-login": {} }));
  assert.match(checkWebSplit(root).join("\n"), /public manifest/);
  write("public/client/assets/manifest-public.js", manifest({ root: {}, "public-layout": {}, alias: { path: "admin/settings" } }));
  assert.match(checkWebSplit(root).join("\n"), /private path/);
  write("private/client/assets/manifest-private.js", manifest({ root: {}, "routes/admin-login": {}, reader: { path: "all" } }));
  assert.match(checkWebSplit(root).join("\n"), /reader path/);
  rmSync(path.join(root, "apps/web/build/public/modules.json"));
  assert.match(checkWebSplit(root).join("\n"), /unavailable/);
});
