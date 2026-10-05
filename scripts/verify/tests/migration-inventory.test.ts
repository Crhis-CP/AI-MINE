import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadMigrationInventory, validateAppliedMigrations } from "../../migrations/inventory.ts";
import { scratch, write } from "./helpers.ts";
import { ROOT } from "../lib.ts";

function fixture() {
  const root = scratch(),
    text = "SELECT 1;";
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "database/migration-inventory.json"), "utf8")) as {
    legacy: { name: string; sha256: string }[];
    migrations: { name: string; dependsOn: string[] }[];
  };
  for (const entry of manifest.legacy)
    write(root, { [`database/migrations/${entry.name}`]: readFileSync(path.join(ROOT, "database/migrations", entry.name), "utf8") });
  // Synthetic topology starts from the fixed legacy baseline; each test registers its own modules.
  manifest.migrations = [];
  const save = () => write(root, { "database/migration-inventory.json": JSON.stringify(manifest) });
  const add = (name: string, dependsOn: string[] = []) => {
    manifest.migrations.push({ name, dependsOn });
    write(root, { [`database/migrations/${name}`]: text });
    save();
  };
  save();
  return { root, manifest, save, add };
}

test("all 30 frozen originals keep their identities and hashes; applied history fails closed", () => {
  const inventory = loadMigrationInventory(ROOT),
    entries = inventory.filter((entry) => entry.module === null);
  assert.deepEqual(
    inventory.filter((entry) => entry.module !== null).map(({ name, module, schemas, dependsOn }) => ({ name, module, schemas, dependsOn })),
    [
      {
        name: "sources/202610040001_source_permissions.sql",
        module: "sources",
        schemas: ["sources"],
        dependsOn: ["0038_publication_source_excerpt.sql"],
      },
      {
        name: "sources/202610042019_source_date_config_identity.sql",
        module: "sources",
        schemas: ["sources"],
        dependsOn: ["0038_publication_source_excerpt.sql", "sources/202610040001_source_permissions.sql"],
      },
      {
        name: "content/202610042020_source_date_evidence.sql",
        module: "content",
        schemas: ["content"],
        dependsOn: ["0038_publication_source_excerpt.sql", "sources/202610042019_source_date_config_identity.sql"],
      },
      {
        name: "publication/202610042021_public_source_time.sql",
        module: "publication",
        schemas: ["publication"],
        dependsOn: ["0038_publication_source_excerpt.sql", "content/202610042020_source_date_evidence.sql"],
      },
      {
        name: "enrichment/202610042100_translation_readiness.sql",
        module: "enrichment",
        schemas: ["enrichment"],
        dependsOn: ["0038_publication_source_excerpt.sql"],
      },
      {
        name: "enrichment/202610050000_translation_attempt_identity.sql",
        module: "enrichment",
        schemas: ["enrichment"],
        dependsOn: ["0038_publication_source_excerpt.sql", "enrichment/202610042100_translation_readiness.sql"],
      },
      {
        name: "ai-gateway/202610050010_receipt_output_rejection.sql",
        module: "ai-gateway",
        schemas: ["ai"],
        dependsOn: ["0038_publication_source_excerpt.sql", "enrichment/202610050000_translation_attempt_identity.sql"],
      },
      {
        name: "enrichment/202610051200_translation_replacements.sql",
        module: "enrichment",
        schemas: ["enrichment"],
        dependsOn: [
          "0038_publication_source_excerpt.sql",
          "enrichment/202610050000_translation_attempt_identity.sql",
          "ai-gateway/202610050010_receipt_output_rejection.sql",
        ],
      },
      {
        name: "ai-gateway/202610051210_translation_receipt_observations.sql",
        module: "ai-gateway",
        schemas: ["ai"],
        dependsOn: ["0038_publication_source_excerpt.sql", "ai-gateway/202610050010_receipt_output_rejection.sql"],
      },
    ],
  );
  assert.equal(entries.length, 30);
  assert.equal(entries[0]!.name, "0001_core.sql");
  assert.equal(entries.at(-1)!.name, "0038_publication_source_excerpt.sql");
  assert.ok(entries.every((entry) => entry.module === null && entry.schemas.join() === "public"));
  const first = entries[0]!;
  validateAppliedMigrations(entries, [{ name: first.name, sha256: null }]);
  validateAppliedMigrations(entries, [{ name: first.name, sha256: first.sha256 }]);
  assert.throws(
    () =>
      validateAppliedMigrations(entries, [
        { name: first.name, sha256: null },
        { name: first.name, sha256: null },
      ]),
    /Duplicate applied/,
  );
  assert.throws(() => validateAppliedMigrations(entries, [{ name: "foreign.sql", sha256: null }]), /Unknown applied/);
  assert.throws(() => validateAppliedMigrations(entries, [{ name: first.name, sha256: "0".repeat(64) }]), /Applied migration hash/);
});

test("module discovery orders dependencies before timestamps and paths, with canonical schemas", () => {
  const f = fixture(),
    later = "sources/202610041000_base.sql",
    earlier = "ai-gateway/202610040900_cost.sql";
  f.add(earlier, [later]);
  f.add(later);
  f.add("platform/identity/202610041000_audit.sql");
  const entries = loadMigrationInventory(f.root);
  assert.deepEqual(
    entries.slice(30).map((entry) => entry.name),
    ["platform/identity/202610041000_audit.sql", later, earlier],
  );
  assert.deepEqual(entries.at(-1)!.schemas, ["ai"]);
  assert.deepEqual(entries[30]!.schemas, ["identity", "audit"]);
});

type InvalidCase = [(f: ReturnType<typeof fixture>) => void, RegExp];
test("changed, missing, unregistered, escaped and cyclic inputs cannot become a valid inventory", () => {
  const cases: InvalidCase[] = [
    [
      (f) => {
        write(f.root, { "database/migrations/0001_core.sql": "SELECT 2;" });
        f.manifest.legacy[0]!.sha256 = createHash("sha256").update("SELECT 2;").digest("hex");
        f.save();
      },
      /Historical manifest identity/,
    ],
    [(f) => write(f.root, { "database/migrations/0001_core.sql": "SELECT 2;" }), /Historical migration hash/],
    [(f) => rmSync(path.join(f.root, "database/migrations/0001_core.sql")), /Missing migration/],
    [(f) => write(f.root, { "database/migrations/0002_new.sql": "SELECT 2;" }), /Unregistered/],
    [
      (f) => {
        f.manifest.legacy.push(f.manifest.legacy[0]!);
        f.save();
      },
      /Duplicate migration identity/,
    ],
    [(f) => f.add("unknown/202610041000_new.sql"), /Unknown module/],
    [
      (f) => {
        f.manifest.migrations.push({ name: "../escape.sql", dependsOn: [] });
        f.save();
      },
      /noncanonical/,
    ],
    [(f) => f.add("sources/202602300000_bad_date.sql"), /Invalid UTC/],
    [(f) => f.add("sources/202610041000_new.sql", ["sources/202610031000_missing.sql"]), /Missing dependency/],
    [
      (f) => {
        f.add("sources/202610041000_a.sql", ["sources/202610041001_b.sql"]);
        f.add("sources/202610041001_b.sql", ["sources/202610041000_a.sql"]);
      },
      /cycle/,
    ],
    [
      (f) => {
        symlinkSync(path.join(f.root, "database/migrations/0001_core.sql"), path.join(f.root, "database/migrations/escape.sql"));
      },
      /symlink/,
    ],
    ...["database", "database/migrations", "database/migrations/sources"].map(
      (name): InvalidCase => [
        (f) => {
          rmSync(path.join(f.root, name), { recursive: true, force: true });
          symlinkSync(path.join(ROOT, "database"), path.join(f.root, name));
        },
        /symlink/,
      ],
    ),
  ];
  for (const [mutate, expected] of cases) {
    const f = fixture();
    mutate(f);
    assert.throws(() => loadMigrationInventory(f.root), expected);
  }
});
