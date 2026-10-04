import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { publicationProjectionBudget, publicationProjectionProof, type PublicationProjection } from "../publication-projection.ts";
import type { extractOwnership } from "../ts-ownership.ts";

const ITEMS = "packages/backend/src/publication/items.ts",
  POOL = "packages/backend/src/publication/pool.ts";
type Fixture = {
  files: Record<string, string>;
  afterItems: string;
  manifest: PublicationProjection;
  prior: Record<string, number>;
  now: Record<string, number>;
  inventory: ReturnType<typeof extractOwnership>;
  lock: string;
};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/publication-projection.json", import.meta.url), "utf8")) as Fixture;
const apply = (copy: Fixture) =>
  publicationProjectionBudget(copy.now, copy.prior, copy.manifest, copy.inventory, copy.lock, (file, before) =>
    file === ITEMS && !before ? copy.afterItems : (copy.files[file] ?? null),
  );

test("the exact v4 projection retains public visibility, current source permission and authored-summary priority", () => {
  assert.ok(publicationProjectionProof(fixture.files[ITEMS]!, fixture.afterItems));
  const result = apply(structuredClone(fixture));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.budget, fixture.now);
  assert.equal(Object.keys(result.budget).length, 4);
});

test("TS7 rejects every extra source edit, weakened condition and SQL escape in the projection", () => {
  const fallback = "coalesce(p.summary, CASE WHEN s.site_fulltext AND p.visibility = 'public' THEN p.source_excerpt END) AS summary";
  const cases: [string, (source: string) => string][] = [
    ["summary-only", (s) => s.replace(" AND p.visibility = 'public'", "")],
    ["permission", (s) => s.replace("s.site_fulltext AND ", "")],
    ["or condition", (s) => s.replace("s.site_fulltext AND", "s.site_fulltext OR")],
    ["source first", (s) => s.replace(fallback, "coalesce(p.source_excerpt, p.summary) AS summary")],
    ["other column", (s) => s.replace("p.score,", "p.reason AS score,")],
    ["predicate body", (s) => s.replace("NOT p.selected", "p.selected")],
    ["import alias", (s) => s.replace("CategoryKey, ChannelKey", "ChannelKey as CategoryKey, CategoryKey as ChannelKey")],
    ["empty import", (s) => `import {} from "./other.ts";\n${s}`],
    ["comma table", (s) => s.replace(fallback, "p.summary, receipts")],
    ["nested relation", (s) => s.replace(fallback, "(SELECT summary FROM receipts) AS summary")],
    ["where", (s) => s.replace(fallback, "p.summary FROM receipts WHERE true")],
    ["statement escape", (s) => s.replace(fallback, "p.summary; SELECT read_secrets(); --")],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Deliberately invalid proof fixture; never executed.
    ["dynamic template", (s) => s.replace(fallback, "${unsafe()} AS summary")],
    ["second declaration", (s) => s.concat("\nconst ITEM_COLUMNS = sql`p.summary`;\n")],
  ];
  for (const [label, mutate] of cases) {
    const after = mutate(fixture.afterItems);
    assert.notEqual(after, fixture.afterItems, label);
    assert.equal(publicationProjectionProof(fixture.files[ITEMS]!, after), undefined, label);
  }
  assert.equal(
    publicationProjectionProof(
      fixture.files[ITEMS]!.replace("export const ITEM_COLUMNS", "export let ITEM_COLUMNS"),
      fixture.afterItems.replace("export const ITEM_COLUMNS", "export let ITEM_COLUMNS"),
    ),
    undefined,
  );
});

test("fixed calls, full blobs, unchanged dependencies, complete SQL and projection offsets are mandatory", () => {
  const cases: [string, (copy: Fixture) => void][] = [
    [
      "wrong before blob",
      (f) => {
        f.files[ITEMS] = f.files[ITEMS]!.replace("NOT p.selected", "p.selected");
      },
    ],
    [
      "trimmed final newline",
      (f) => {
        f.files[ITEMS] = f.files[ITEMS]!.trimEnd();
      },
    ],
    [
      "wrong current blob",
      (f) => {
        f.afterItems += "\n";
      },
    ],
    [
      "caller import or helper edit",
      (f) => {
        f.files[POOL] += "\nimport {} from './other.ts';\n";
      },
    ],
    [
      "wrong manifest before",
      (f) => {
        f.manifest.before = "0".repeat(64) as never;
      },
    ],
    [
      "wrong manifest after",
      (f) => {
        f.manifest.after = "0".repeat(64) as never;
      },
    ],
    [
      "SQL text changed",
      (f) => {
        f.manifest.sites[0]!.sql += " ";
      },
    ],
    [
      "wrong function",
      (f) => {
        f.manifest.sites[0]!.scopeName = "other";
      },
    ],
    [
      "other dependency",
      (f) => {
        f.inventory[0]!.sites[0]!.dependencies[POOL] = "0".repeat(64);
      },
    ],
    [
      "parser lock",
      (f) => {
        f.lock = "0".repeat(64);
      },
    ],
    [
      "reason",
      (f) => {
        f.inventory[0]!.sites[0]!.unknown.push("another opaque call");
      },
    ],
    [
      "position",
      (f) => {
        f.manifest.sites[0]!.projectionOffsets[0]![0]++;
      },
    ],
    [
      "shape",
      (f) => {
        f.manifest.sites[0]!.shape += " from receipts";
      },
    ],
    [
      "current shape cannot pose as before",
      (f) => {
        f.manifest.sites[0]!.shape = f.inventory[0]!.sites[0]!.shape;
      },
    ],
    [
      "copied slot",
      (f) => {
        f.manifest.sites[1] = structuredClone(f.manifest.sites[0]!);
      },
    ],
    [
      "extra slot",
      (f) => {
        f.manifest.sites.push(structuredClone(f.manifest.sites[0]!));
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const copy = structuredClone(fixture);
    mutate(copy);
    const result = apply(copy);
    assert.ok(result.errors.length, label);
    assert.deepEqual(result.budget, copy.prior, `${label}: failure cannot consume an allowance`);
  }
});

test("old allowances are consumed exactly once and cannot be manufactured, copied or increased", () => {
  for (const mutate of [
    (f: Fixture) => {
      f.prior = {};
    },
    (f: Fixture) => {
      f.now[Object.keys(f.now)[0]!] = 2;
    },
    (f: Fixture) => {
      f.prior[Object.keys(f.prior)[0]!] = 2;
    },
    (f: Fixture) => {
      f.now[Object.keys(f.prior)[0]!] = 1;
    },
    (f: Fixture) => {
      f.prior[Object.keys(f.now)[0]!] = 1;
    },
  ]) {
    const copy = structuredClone(fixture);
    mutate(copy);
    assert.ok(apply(copy).errors.length);
  }
  const replay = structuredClone(fixture);
  replay.prior = { ...fixture.now };
  assert.deepEqual(apply(replay), { budget: fixture.now, errors: [] });
  replay.now[Object.keys(fixture.prior)[0]!] = 1;
  assert.ok(apply(replay).errors.length, "historical evidence cannot restore a spent old slot");
  const pruned = structuredClone(fixture);
  pruned.prior = {};
  pruned.now = {};
  assert.deepEqual(apply(pruned), { budget: {}, errors: [] }, "historical metadata cannot revive debt after proof eliminates all slots");
});
