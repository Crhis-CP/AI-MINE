import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import { sqlLockFingerprint } from "../sql-lock.ts";

const original = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
type Lock = {
  importers: Record<string, unknown>;
  packages: Record<string, { resolution: { integrity: string } }>;
  snapshots: Record<string, Record<string, unknown>>;
};
function changed(mutate: (lock: Lock) => void): string {
  const docs = parseAllDocuments(original).map((doc) => doc.toJS() as Lock);
  const app = docs.find((doc) => doc.importers["packages/backend"])!;
  mutate(app);
  return docs.map((doc) => `---\n${stringify(doc)}`).join("");
}

test("pnpm12 multi-document subgraph ignores unrelated workspace/tooling entries", () => {
  const before = sqlLockFingerprint(original);
  const after = changed((lock) => {
    lock.importers["tooling-lock-test"] = { devDependencies: { typescript: { specifier: "5.9.3", version: "5.9.3" } } };
    lock.packages["typescript@5.9.3"] = { resolution: { integrity: "fixture-unrelated-parser" } };
    lock.snapshots["typescript@5.9.3"] = {};
  });
  assert.notEqual(after, original);
  assert.equal(sqlLockFingerprint(after).fingerprint, before.fingerprint);
  assert.ok(before.snapshots.some((key) => key.startsWith("pg-pool@") && key.includes("(pg@")));
  assert.ok(before.packages.some((key) => key.startsWith("@typescript/typescript-linux-x64@")));
});

test("SQL roots, transitive entries and native parser integrity remain bound", () => {
  const before = sqlLockFingerprint(original);
  for (const prefix of ["postgres@", "pg-boss@", "pg-connection-string@", "@typescript/typescript-linux-x64@", "typescript@"]) {
    const key = before.packages.find((name) => name.startsWith(prefix))!;
    assert.ok(key, prefix);
    const after = changed((lock) => {
      lock.packages[key].resolution.integrity += "-changed";
    });
    assert.notEqual(sqlLockFingerprint(after).fingerprint, before.fingerprint, key);
  }
  const key = before.snapshots.find((name) => name.startsWith("pg-boss@"))!;
  assert.notEqual(
    sqlLockFingerprint(
      changed((lock) => {
        lock.snapshots[key].transitivePeerDependencies = [];
      }),
    ).fingerprint,
    before.fingerprint,
  );
});

test("missing nodes, invalid maps and unsupported lock input fail instead of shrinking the graph", () => {
  const before = sqlLockFingerprint(original),
    key = before.packages.find((name) => name.startsWith("postgres@"))!;
  assert.throws(
    () =>
      sqlLockFingerprint(
        changed((lock) => {
          delete lock.packages[key];
        }),
      ),
    /Unsupported lock record/,
  );
  assert.throws(
    () =>
      sqlLockFingerprint(
        changed((lock) => {
          delete lock.snapshots[key];
        }),
      ),
    /Unsupported lock record/,
  );
  const queue = before.snapshots.find((name) => name.startsWith("pg-boss@"))!;
  assert.throws(
    () =>
      sqlLockFingerprint(
        changed((lock) => {
          lock.snapshots[queue].dependencies = null;
        }),
      ),
    /Unsupported lock record/,
  );
  assert.throws(
    () =>
      sqlLockFingerprint(
        changed((lock) => {
          lock.snapshots[queue].dependencies = { pg: "link:other" };
        }),
      ),
    /Unsupported dependency reference/,
  );
  assert.throws(() => sqlLockFingerprint("invalid: ["), /Cannot parse/);
});

test("npm SQL graphs retain nested resolution, installed peers and complete fingerprint metadata", () => {
  const expected = sqlLockFingerprint(original).normalized;
  const packages: Record<string, Record<string, unknown>> = {};
  const parts = (key: string) => [key.slice(0, key.lastIndexOf("@")), key.slice(key.lastIndexOf("@") + 1)] as const;
  for (const [key, node] of Object.entries(expected.nodes)) {
    const [name, version] = parts(key);
    assert.equal(packages[`node_modules/${name}`], undefined, "fixture has one resolved version per SQL dependency");
    packages[`node_modules/${name}`] = {
      version,
      integrity: node.integrity,
      resolved: `https://fixture.invalid/${name}/${version}.tgz`,
      dependencies: Object.fromEntries(Object.entries(node.dependencies).map(([child, target]) => [child, parts(target)[1]])),
    };
  }
  for (const [key, root] of Object.entries(expected.roots)) {
    const [name] = parts(root.target),
      importer = key.slice(0, -(name.length + 1));
    const location = importer === "." ? "" : importer;
    packages[location] ??= {};
    const entry = packages[location];
    entry[root.kind] ??= {} as Record<string, string>;
    (entry[root.kind] as Record<string, string>)[name] = root.specifier;
  }
  const read = () => sqlLockFingerprint(JSON.stringify({ lockfileVersion: 3, packages }));
  assert.deepEqual(read().normalized, expected);
  const pool = packages["node_modules/pg-pool"];
  packages["node_modules/pg/node_modules/pg-pool"] = pool;
  delete packages["node_modules/pg-pool"];
  delete (pool.dependencies as Record<string, string>).pg;
  pool.peerDependencies = { pg: "^8" };
  assert.deepEqual(read().normalized, expected);
  const before = read().fingerprint;
  pool.peerDependenciesMeta = { pg: { optional: true } };
  assert.notEqual(read().fingerprint, before, "metadata remains fingerprinted even when the installed peer is unchanged");
  const driver = packages["node_modules/postgres"];
  driver.dependencies = null;
  assert.throws(read, /Unsupported lock record/);
  delete driver.dependencies;
  driver.link = true;
  assert.throws(read, /Unsupported npm SQL package/);
  delete packages["node_modules/postgres"];
  assert.throws(read, /Missing npm SQL dependency/);
});
