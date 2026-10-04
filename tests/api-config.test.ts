import assert from "node:assert/strict";
import { test } from "node:test";
import { apiRoleFromEnv, publicApiCredentialNames, assertPublicApiCredentials, databaseConfig, environmentProblems } from "@amp/config";

const forbidden = [
  "SESSION_SECRET",
  "ADMIN_PASSWORD",
  "ADMIN_FEISHU_UNION_IDS",
  "ADMIN_EMAILS",
  "INGEST_TOKEN",
  "AMP_CREDENTIALS_DIR",
  "DAJIALA_KEY",
  "FEISHU_PUSH_WEBHOOK_URL",
  "FEISHU_PUSH_MIRROR_WEBHOOK_URL",
  "DB_BACKUP_STORE_SECRET_ID",
  "DB_BACKUP_STORE_SECRET_KEY",
  "LLM_API_KEY",
  "EMBEDDING_API_KEY",
  "FUTURE_API_KEY",
  "FEISHU_LOGIN_APP_ID",
  "FEISHU_LOGIN_APP_SECRET",
  "FEISHU_LOGIN_FUTURE",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_APP_FUTURE",
  "FEISHU_ALERT_CHAT_ID",
  "FEISHU_INTERNAL_CHAT_ID",
  "FEISHU_FUTURE_CHAT_ID",
];

test("API_ROLE parsing accepts only the two explicit roles and never includes rejected values", () => {
  for (const role of ["public-api", "private-api"] as const) assert.equal(apiRoleFromEnv({ API_ROLE: role }), role);
  for (const value of [undefined, "", " ", "api", "worker", "PUBLIC-API", " public-api", "private-api ", "PRIVATE_MARKER"]) {
    assert.throws(() => apiRoleFromEnv({ API_ROLE: value }), { message: "API_ROLE must be public-api or private-api" });
  }
});

test("D7 detects every declared credential family, including empty values, and returns names in stable order", () => {
  for (const name of forbidden) {
    for (const value of ["", " ", "PRIVATE_MARKER"]) assert.deepEqual(publicApiCredentialNames({ [name]: value }), [name]);
    assert.deepEqual(publicApiCredentialNames({ [name]: undefined }), []);
  }
  assert.deepEqual(publicApiCredentialNames(Object.fromEntries(forbidden.toReversed().map((name) => [name, "PRIVATE_MARKER"]))), forbidden.toSorted());
});

test("explicit public validation rejects in production and warns once per call in other modes without values", () => {
  const values = Object.fromEntries(forbidden.map((name) => [name, "PRIVATE_MARKER"]));
  const expected = `public-api must not hold ${forbidden.toSorted().join(", ")}`;
  const warnings: string[] = [];
  assert.throws(() => assertPublicApiCredentials({ ...values, NODE_ENV: "production", AMP_ENVIRONMENT: "development" }, (message) => warnings.push(message)), {
    message: expected,
  });
  assert.deepEqual(warnings, []);
  for (const mode of [undefined, "development", "test"]) {
    const messages: string[] = [];
    assertPublicApiCredentials({ ...values, NODE_ENV: mode, AMP_ENVIRONMENT: "production" }, (message) => messages.push(message));
    assert.deepEqual(messages, [expected]);
    assert.ok(!messages.join().includes("PRIVATE_MARKER"));
  }
  for (const name of forbidden) {
    assert.throws(() => assertPublicApiCredentials({ NODE_ENV: "production", [name]: "" }), { message: `public-api must not hold ${name}` });
  }
});

test("the helper does not broaden D7 or impose required-key and private/worker policies", () => {
  const allowed = [
    "PUBLIC_RATE_LIMIT_SECRET",
    "INDEXNOW_KEY",
    "IMG_PROXY_SIGN_SECRET",
    "DATABASE_URL",
    "DATABASE_URL_PUBLIC_READ",
    "DATABASE_URL_FEEDBACK_WRITE",
    "GITHUB_TOKEN",
    "FUTURE_KEY",
    "FUTURE_TOKEN",
    "FUTURE_SECRET",
    "SESSION_SECRET_EXTRA",
    "INGEST_TOKEN_EXTRA",
    "FEISHU_CONTENT_PUSH_ENABLED",
    "FEISHU_INTERNAL_ENABLED",
    "MCP_ALLOWED_HOSTS",
    "PRIVATE_HOST",
  ];
  const env = { NODE_ENV: "production", ...Object.fromEntries(allowed.map((name) => [name, "PRIVATE_MARKER"])) };
  assert.deepEqual(publicApiCredentialNames(env), []);
  assert.doesNotThrow(() => assertPublicApiCredentials(env, () => assert.fail("clean input must not warn")));
  assert.doesNotThrow(() => assertPublicApiCredentials({ NODE_ENV: "production" }));
});

test("preparation is not automatically activated through existing config or database entry points", () => {
  const env = { NODE_ENV: "production", DATABASE_URL: "postgres://test@127.0.0.1:1/api_config_test", SESSION_SECRET: "PRIVATE_MARKER", LLM_API_KEY: "" };
  for (const role of ["api", "public-api", "private-api", "worker"] as const) {
    assert.deepEqual(environmentProblems(role, env), []);
    assert.doesNotThrow(() => databaseConfig(role, env));
  }
});
