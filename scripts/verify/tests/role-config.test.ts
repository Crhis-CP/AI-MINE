import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRoleConfig } from "../role-config.ts";
import { scratch, write } from "./helpers.ts";

const inspect = (compose: string) => {
  const dir = scratch();
  write(dir, { "docker-compose.yml": compose });
  return checkRoleConfig(dir, ["web"]);
};
test("role matrices and clean Compose mapping/list environments agree", () => {
  for (const environment of [
    "{NODE_ENV: production, SITE_URL: 'https://example.test', ALLOW_PRIVATE_NETWORK_FETCH: false}",
    "[NODE_ENV=production, API_BASE_URL=http://api, PATH]",
  ])
    assert.deepEqual(inspect(`services:\n  web:\n    environment: ${environment}\n`), []);
  assert.deepEqual(inspect("services: {web: {image: web}}"), []);
});
test("merged env_file and credentials cannot be hidden by YAML anchors", () => {
  const problems = inspect(
    "x-common: &common\n  env_file: .env\n  environment: &env\n    LLM_API_KEY: do-not-print\nservices:\n  web:\n    <<: *common\n    environment:\n      <<: *env\n      PORT: 3000\n",
  );
  assert.ok(problems.some((p) => p.includes("env_file")));
  assert.ok(problems.some((p) => p.includes("LLM_API_KEY")));
  assert.ok(!problems.join().includes("do-not-print"));
});
test("list credentials, empty values and inherited values are all present", () => {
  for (const entry of ["LLM_API_KEY=do-not-print", "DATABASE_URL=", "PGSERVICEFILE", "DB_BACKUP_STORE_SECRET_ID", "http_proxy=do-not-print"])
    assert.match(inspect(`services:\n  web:\n    environment:\n      - ${entry}\n`).join(), /web must not hold/);
  assert.match(inspect("services: {web: {environment: {NEW_TOKEN: null}}}").join(), /NEW_TOKEN/);
});
test("production Compose cannot bypass proxy checks with a development value or interpolation", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: an unresolved Compose substitution, tested as data
  for (const mode of ["development", "${NODE_ENV:-production}"])
    assert.match(inspect(`services: {web: {environment: {NODE_ENV: '${mode}', HTTP_PROXY: ''}}}`).join(), /HTTP_PROXY/);
});
test("missing services, invalid environment shapes and parse errors fail without values", () => {
  for (const compose of [
    "services: {}",
    "services: {web: []}",
    "services: {web: {environment: null}}",
    "services: {web: {environment: do-not-print}}",
    "services: {web: {environment: [7]}}",
    "services: {web: {environment: {A: [do-not-print]}}}",
    "services: {web: {environment: {A: do-not-print, A: other}}}",
  ])
    assert.ok(inspect(compose).some((p) => p.startsWith("docker-compose.yml:") && !p.includes("do-not-print")));
  assert.match(checkRoleConfig(scratch()).join(), /cannot read or parse/);
});

test("unknown YAML tags fail without emitting the original configuration line", () => {
  const emitWarning = process.emitWarning;
  const warnings: string[] = [];
  process.emitWarning = (warning) => {
    warnings.push(String(warning));
  };
  try {
    const problems = inspect("services: {web: {environment: {FUTURE_TOKEN: !secret PRIVATE_MARKER}}}");
    assert.deepEqual(problems, ["docker-compose.yml: cannot read or parse configuration"]);
    assert.deepEqual(warnings, []);
    assert.ok(!problems.join().includes("PRIVATE_MARKER"));
  } finally {
    process.emitWarning = emitWarning;
  }
});

test("private-network access must be statically disabled without expanding Compose variables", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose expressions are unexpanded input fixtures
  const uncertain = ["${PRIVATE_FETCH:-true}", "${PRIVATE_FETCH:-false}", "${PRIVATE_FETCH}", "$PRIVATE_FETCH", "${OUTER:-${INNER:-false}}"];
  for (const value of uncertain) {
    for (const environment of [`{ALLOW_PRIVATE_NETWORK_FETCH: '${value}'}`, `["ALLOW_PRIVATE_NETWORK_FETCH=${value}"]`]) {
      const problems = inspect(`services:\n  web:\n    environment: ${environment}\n`);
      assert.deepEqual(problems, ["docker-compose.yml: web must not hold ALLOW_PRIVATE_NETWORK_FETCH"]);
      assert.ok(!problems.join().includes(value));
    }
  }
  for (const environment of ["{ALLOW_PRIVATE_NETWORK_FETCH: null}", "[ALLOW_PRIVATE_NETWORK_FETCH]"]) {
    assert.deepEqual(inspect(`services:\n  web:\n    environment: ${environment}\n`), ["docker-compose.yml: web must not hold ALLOW_PRIVATE_NETWORK_FETCH"]);
  }
  assert.deepEqual(inspect("services: {web: {environment: [ALLOW_PRIVATE_NETWORK_FETCH=false, ALLOW_PRIVATE_NETWORK_FETCH]}}"), [
    "docker-compose.yml: web must not hold ALLOW_PRIVATE_NETWORK_FETCH",
  ]);
  assert.deepEqual(inspect("services: {web: {environment: [ALLOW_PRIVATE_NETWORK_FETCH, ALLOW_PRIVATE_NETWORK_FETCH=false]}}"), []);
});

test("known disabled literals and absent flags keep passing, including escaped dollars", () => {
  for (const value of ["false", "FALSE", "0", "", "$${PRIVATE_FETCH}"]) {
    for (const environment of [`{ALLOW_PRIVATE_NETWORK_FETCH: '${value}'}`, `["ALLOW_PRIVATE_NETWORK_FETCH=${value}"]`]) {
      assert.deepEqual(inspect(`services:\n  web:\n    environment: ${environment}\n`), []);
    }
  }
  assert.deepEqual(inspect("services: {web: {environment: {ALLOW_PRIVATE_NETWORK_FETCH: false}}}"), []);
  assert.deepEqual(inspect("services: {web: {environment: {ALLOW_PRIVATE_NETWORK_FETCH: 0}}}"), []);
  assert.deepEqual(inspect("services: {web: {environment: {PATH: null}}}"), []);
});
