import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { browserExecutable, localRequest } from "../../../e2e/browser.ts";

test("browser requests require an exact loopback HTTP origin without credentials", () => {
  const allowed = ["http://127.0.0.1:43210", "http://private.localhost:43210"];
  for (const url of [`${allowed[0]}/all?q=test`, `${allowed[1]}/admin/login`]) assert.equal(localRequest(url, allowed), true);
  const withCredentials = new URL(allowed[0]);
  withCredentials.username = "test-user";
  withCredentials.password = "test-password";
  for (const url of [
    "https://example.invalid",
    "http://127.0.0.1:43211",
    "https://127.0.0.1:43210",
    withCredentials.href,
    "http://private.localhost.attacker.invalid:43210",
    "file:///tmp/test",
    "invalid",
  ])
    assert.equal(localRequest(url, allowed), false, url);
  assert.equal(localRequest("https://example.invalid", ["https://example.invalid"]), false);
  assert.throws(() => browserExecutable("/nonexistent-e2e-chrome"), /does not exist/);
});

test("the web-only clock preserves native Date constructors and fixed no-argument time", () => {
  execFileSync(
    process.execPath,
    [
      "--import",
      "./e2e/web-clock.ts",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    assert.equal(new Date().toISOString(), '2026-10-04T02:00:00.000Z');
    assert.equal(Date.now(), Date.parse('2026-10-04T02:00:00.000Z'));
    assert.equal(new Date(2024, 1, 29).getDate(), 29);
    assert.equal(new Date(0).getTime(), 0);
    assert(Number.isNaN(new Date(undefined).getTime()));
  `,
    ],
    { env: { TZ: "UTC" } },
  );
});
