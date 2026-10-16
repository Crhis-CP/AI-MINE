import assert from "node:assert/strict";
import { test } from "node:test";
import { defineModule, type ModuleDeclaration } from "../src/modules.ts";
test("extension addresses retain explicit public/admin separation and existing redirect policy", () => {
  const module: ModuleDeclaration = {
    name: "metals",
    pages: [{ path: "metals", file: "routes/prices.tsx" }],
    adminPages: [{ path: "admin/metals", file: "routes/manage.tsx" }],
    redirects: [{ match: "exact", path: "/prices", status: 308, location: "/metals" }],
    apiPaths: [/^\/api\/site\/metal-prices(?:\?|$)/],
  };
  const value = defineModule(module);
  assert.equal(value.pages?.length, 1);
  assert.equal(value.adminPages?.[0]?.path, "admin/metals");
  assert.ok(value.apiPaths?.[0]?.test("/api/site/metal-prices"));
  assert.ok(!value.apiPaths?.[0]?.test("/api/admin/accounts"));
  assert.equal(value.redirects?.[0]?.status, 308);
});
