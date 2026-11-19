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
  write("reader/client/assets/manifest-reader.js", manifest({ root: {}, "public-layout": {}, "routes/home": { path: "en?" } }));
  write("reader/modules.json", '["reader/root.tsx", "app/lib/visit-beacon.ts"]');
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

test("the rewritten reader's build gets the public proofs, holds no old reader code and no private-only file name", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "amp-web-split-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, text: string) => {
    const target = path.join(root, "apps/web/build", file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const manifest = (routes: Record<string, unknown>) => `window.__reactRouterManifest=${JSON.stringify({ routes })};`;
  write("public/client/assets/manifest-public.js", manifest({ root: {}, "public-layout": {} }));
  write("public/client/assets/shared-font.woff2", "font");
  write("private/client/assets/manifest-private.js", manifest({ root: {}, "routes/admin-login": {} }));
  write("private/client/assets/shared-font.woff2", "font");
  write("private/client/assets/admin-chart.png", "png");
  write("public/modules.json", '["app/root.tsx"]');
  write("reader/client/assets/manifest-reader.js", manifest({ root: {}, "public-layout": {} }));
  write("reader/client/assets/shared-font.woff2", "font");
  write("reader/modules.json", '["reader/root.tsx"]');
  assert.deepEqual(checkWebSplit(root), []);
  // A missing reader build fails closed, like a missing public one.
  rmSync(path.join(root, "apps/web/build/reader/modules.json"));
  assert.match(checkWebSplit(root).join("\n"), /unavailable/);
  for (const id of [
    "app/routes/home.tsx",
    "app/features/feed/Timeline.tsx",
    "app/components/Logo.tsx",
    "../../modules/policy/web/reader.tsx",
    "../../modules/policy/web.ts",
    "../../site/modules/web.ts",
  ]) {
    write("reader/modules.json", JSON.stringify(["reader/root.tsx", id]));
    assert.match(checkWebSplit(root).join("\n"), /reader module graph includes old reader code/, id);
  }
  write("reader/modules.json", '["reader/root.tsx", "app/features/admin/toast.tsx"]');
  assert.match(checkWebSplit(root).join("\n"), /reader module graph includes app\/features\/admin/);
  write("reader/modules.json", '["reader/root.tsx"]');
  write("reader/client/assets/manifest-reader.js", manifest({ root: {}, "public-layout": {}, "routes/admin-login": {} }));
  assert.match(checkWebSplit(root).join("\n"), /reader manifest exposes private route/);
  write("reader/client/assets/manifest-reader.js", manifest({ root: {}, "public-layout": {}, alias: { path: "admin/settings" } }));
  assert.match(checkWebSplit(root).join("\n"), /reader manifest exposes private path/);
  write("reader/client/assets/manifest-reader.js", manifest({ root: {} }));
  assert.match(checkWebSplit(root).join("\n"), /unavailable/);
  write("reader/client/assets/manifest-reader.js", manifest({ root: {}, "public-layout": {} }));
  write("reader/client/assets/probe.js", '"/api/admin/x"');
  assert.match(checkWebSplit(root).join("\n"), /reader asset contains/);
  rmSync(path.join(root, "apps/web/build/reader/client/assets/probe.js"));
  // The public host would answer this name from the reader build, where a private-only file must be 404.
  write("reader/client/assets/admin-chart.png", "png");
  assert.deepEqual(checkWebSplit(root), ["reader build has a private-only file name: assets/admin-chart.png"]);
});
