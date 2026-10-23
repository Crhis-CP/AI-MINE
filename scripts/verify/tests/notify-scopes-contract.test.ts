import assert from "node:assert/strict";
import { test } from "node:test";
import { NotifyTargetScopeUpdate, NotifyTargetScopes, routes } from "@amp/contracts/http/private";

test("country scope is explicit, versioned and does not also change enablement or credentials", () => {
  const request = { jurisdiction: "AR", version: "2026-10-23 18:00:00.123456+00", reason: "只接收阿根廷相关精选" };
  assert.equal(NotifyTargetScopeUpdate.parse(request).jurisdiction, "AR");
  assert.equal(NotifyTargetScopeUpdate.parse({ ...request, jurisdiction: null }).jurisdiction, null);
  for (const patch of [{ jurisdiction: "" }, { jurisdiction: "argentina" }, { version: "" }, { reason: " " }, { enabled: true }, { webhook: "secret" }])
    assert.equal(NotifyTargetScopeUpdate.safeParse({ ...request, ...patch }).success, false);
  assert.deepEqual(NotifyTargetScopes.parse({ items: [] }), { items: [] });
  assert.equal(routes.notifyTargetScopeUpdate.schema.headers.safeParse({}).success, false);
  assert.equal(routes.notifyTargetScopeUpdate.schema.headers.safeParse({ "idempotency-key": "scope-change-20261023" }).success, true);
});
