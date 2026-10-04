import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../ts-ownership.ts";
import { importsOnly, rekeyUnknownBudget, unknownRekeyKeys, type UnknownRekey } from "../unknown-rekeys.ts";

const file = "packages/backend/src/publication/feeds.ts";
const before = "import { LABEL } from 'old';\nconst table = () => 'items';\nexport const query = sql.unsafe(table());\n";
const after = before.replace("'old'", "'new'");
const expression = "sql.unsafe(table())";
const entry: UnknownRekey = {
  file,
  scopeName: "query",
  sourceHash: digest(expression),
  reasons: ["dynamic raw SQL"],
  before: { [file]: digest(before), "sql/parser-locked-subgraph": digest("locked") },
  after: { [file]: digest(after), "sql/parser-locked-subgraph": digest("locked") },
};
const keys = unknownRekeyKeys(entry);
const previous = { [keys.before]: 1 },
  current = { [keys.after]: 1 };
const read = (_file: string, old: boolean) => (old ? before : after);

test("an import-only rekey consumes one exact old identity and is inert on merged main", () => {
  assert.deepEqual(rekeyUnknownBudget(current, previous, [entry], read), { budget: current, errors: [] });
  assert.deepEqual(rekeyUnknownBudget(current, current, [entry]), { budget: current, errors: [] });
  assert.deepEqual(rekeyUnknownBudget(current, previous), { budget: previous, errors: [] });
});

test("unchanged SQL call text cannot hide an edited same-file SQL helper", () => {
  const changed = after.replace("'items'", "'private_secrets'");
  assert.ok(changed.includes(expression));
  const altered = structuredClone(entry);
  altered.after[file] = digest(changed);
  const now = { [unknownRekeyKeys(altered).after]: 1 };
  assert.match(rekeyUnknownBudget(now, previous, [altered], (_file, old) => (old ? before : changed)).errors.join("\n"), /import-only/);
  assert.equal(importsOnly("const x = `import X from 'a'`;", "const x = `import X from 'b'`;"), false);
});

test("missing or byte-mismatched source evidence is rejected", () => {
  assert.ok(rekeyUnknownBudget(current, previous, [entry]).errors.length);
  assert.ok(rekeyUnknownBudget(current, previous, [entry], () => after).errors.length);
  assert.ok(rekeyUnknownBudget(current, previous, [entry], (_file, old) => (old ? before.trimEnd() : after)).errors.length);
});

for (const [name, alter] of [
  [
    "SQL expression",
    (r: UnknownRekey) => {
      r.sourceHash = digest("another query");
    },
  ],
  [
    "function",
    (r: UnknownRekey) => {
      r.scopeName = "anotherFunction";
    },
  ],
  [
    "reason",
    (r: UnknownRekey) => {
      r.reasons.push("different opaque operation");
    },
  ],
  [
    "parser dependency",
    (r: UnknownRekey) => {
      r.after["sql/parser-locked-subgraph"] = digest("upgraded");
    },
  ],
  [
    "added dependency",
    (r: UnknownRekey) => {
      r.after["packages/backend/new.ts"] = digest("new");
    },
  ],
  [
    "missing owning dependency",
    (r: UnknownRekey) => {
      delete r.before[file];
    },
  ],
] as const) {
  test("cannot transfer to a changed " + name, () => {
    const altered = structuredClone(entry);
    alter(altered);
    const now = { [unknownRekeyKeys(altered).after]: 1 };
    assert.ok(rekeyUnknownBudget(now, previous, [altered], read).errors.length);
  });
}

test("budgets cannot be copied, increased, double-spent or manufactured", () => {
  for (const [now, prior, entries] of [
    [{ ...current, ...previous }, previous, [entry]],
    [{ [keys.after]: 2 }, previous, [entry]],
    [current, previous, [entry, entry]],
    [current, {}, [entry]],
  ] as const)
    assert.ok(rekeyUnknownBudget(now, prior, [...entries], read).errors.length);
  assert.ok(rekeyUnknownBudget(current, previous, [{ ...entry, sourceHash: "not-a-hash" }], read).errors.length);
  assert.ok(rekeyUnknownBudget(current, previous, [{ ...entry, file: "packages/../../outside.ts" }], read).errors.length);
});
