import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { composeEnvironmentProblems } from "../compose-environment.ts";

const fixture = () => ({ services: { web: {}, db: { networks: ["db"] } }, networks: { db: { internal: true } } });
const inspect = (doc: unknown) => composeEnvironmentProblems(doc, "web");

test("database isolation accepts lists, mappings and inherited networks, while legacy fixtures without db remain valid", () => {
  assert.deepEqual(inspect(fixture()), []);
  assert.deepEqual(inspect({ ...fixture(), services: { web: { networks: { default: null } }, db: { networks: { db: {} } } } }), []);
  assert.deepEqual(inspect({ services: { web: {}, "public-api": {} } }), []);
  const inherited = parse("x-db: &db {networks: [db]}\nservices: {web: {}, db: {<<: *db}}\nnetworks: {db: {internal: true}}", { merge: true });
  assert.deepEqual(inspect(inherited), []);
});

test("database isolation rejects external or extra networks, malformed attachments and shared network namespaces", () => {
  const cases: unknown[] = [
    { ...fixture(), networks: { db: { internal: false } } },
    { ...fixture(), services: { web: {}, db: null } },
    { ...fixture(), services: { web: {}, db: {} } },
    { ...fixture(), services: { web: {}, db: { networks: ["db", "default"] } } },
    { ...fixture(), services: { web: { networks: ["db"] }, db: { networks: ["db"] } } },
    { ...fixture(), services: { web: { networks: { db: null } }, db: { networks: { db: null } } } },
    { ...fixture(), services: { web: { networks: 42 }, db: { networks: ["db"] } } },
    { ...fixture(), services: { web: {}, db: { networks: "db" } } },
  ];
  for (const network_mode of ["host", "service:api", "container:fixture"])
    cases.push({ ...fixture(), services: { web: { network_mode }, db: { networks: ["db"] } } });
  cases.push({ ...fixture(), services: { web: {}, db: { networks: ["db"], network_mode: "host" } } });
  for (const doc of cases) assert.ok(inspect(doc).length, JSON.stringify(doc));
});

test("the repository compose keeps backend connectivity and requires an explicit nonempty database password", () => {
  const doc = parse(readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8"), { merge: true });
  assert.deepEqual(inspect(doc), []);
  assert.deepEqual(doc.services.db.networks, ["db"]);
  assert.equal(doc.networks.db.internal, true);
  for (const name of ["setup", "api", "worker"]) assert.deepEqual(doc.services[name].networks, ["default", "db"]);
  for (const name of ["web", "caddy"]) assert.equal(doc.services[name].networks, undefined);
  assert.equal(doc.services.db.ports, undefined);
  const required = doc.services.db.environment.POSTGRES_PASSWORD;
  assert.match(required, /^\$\{POSTGRES_PASSWORD:\?[^}]+\}$/);
  assert.equal(doc.services.api.environment.DATABASE_URL, `postgres://amp:${required}@db:5432/amp`);
});
