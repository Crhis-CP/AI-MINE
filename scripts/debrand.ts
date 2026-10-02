// De-branding by script (docs/07-bootstrap/01-new-repo-bootstrap.md §5 item 2; docs/04-architecture/
// 04-aihot-adoption.md 4.3; TASK-0003): renames every identifier that still carries the upstream project's
// name, in one pass that can be re-run on any commit. The name is read from scripts/verify/names.json, the only
// file that spells it out. Its lower-case form becomes `amp` (the package scope @amp/* of AGENTS.md, and the
// config keys, cookies, headers, storage keys, keyframes, file, image and database names), its upper-case form
// `AMP` (environment variables), and the root package takes the repository's name (ai-mining-policy, DEC-28).
// Files on the name check's exception paths are left alone, and so are the paths and file names of the
// registration and handoff files. Any other spelling (mixed case, the spaced form) is reported for a person to
// rewrite and nothing is written.
//   node scripts/debrand.ts           rename and print each identifier's old and new form
//   node scripts/debrand.ts --check   exit 1 when something is left to rename, without writing
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./verify/lib.ts";
import { exemption, findHits, loadRules } from "./verify/names.ts";
import { trackedFiles } from "./verify/toolchain.ts";

const rules = loadRules();
const name = rules.names.find((n) => !/\s/.test(n))!.toLowerCase(); // the form without a space
const NAME = name.toUpperCase();
const TO = "amp";
const ROOT_PACKAGE = "ai-mining-policy";
const check = process.argv.includes("--check");

/** The text with the references swapped for numbered placeholders, and the function that puts them back. */
function protect(text: string): [string, (t: string) => string] {
  const kept: string[] = [];
  const masked = rules.references.reduce((t, r) => t.replace(new RegExp(r, "g"), (m) => `\0${kept.push(m) - 1}\0`), text);
  return [masked, (t) => t.replace(/\0(\d+)\0/g, (_, i: string) => kept[Number(i)]!)];
}

const rename = (text: string) => text.replaceAll(name, TO).replaceAll(NAME, TO.toUpperCase());

// Whole identifiers around the name, for the report (package names collapse to the scope).
const FORM = new RegExp(`[\\w@$.:/{}-]*(?:${name})[\\w$.:/{}-]*`, "gi");
const form = (token: string) => token.replace(/^(@[\w-]+\/).*/, "$1*");

const changed: Array<[file: string, text: string]> = [];
const forms = new Map<string, { to: string; count: number }>();
const count = (before: string, to: string) => {
  const entry = forms.get(before) ?? { to, count: 0 };
  entry.count += 1;
  forms.set(before, entry);
};
const left: string[] = [];
for (const file of trackedFiles()) {
  if (exemption(ROOT, file, rules)) continue;
  if (findHits(file, rules).length) left.push(`${file}: the path itself (rename the file by hand)`);
  let buf: Buffer;
  try {
    buf = readFileSync(path.join(ROOT, file));
  } catch {
    continue;
  }
  if (buf.includes(0)) continue; // binary: the name check's hash and byte search cover it
  const [masked, restore] = protect(buf.toString("utf8"));
  let text = masked;
  const rootName = `"name": "${name}"`;
  if (file === "package.json" && text.includes(rootName)) {
    text = text.replace(rootName, `"name": "${ROOT_PACKAGE}"`);
    count(`${rootName} (package.json)`, `"name": "${ROOT_PACKAGE}"`);
  }
  for (const m of text.matchAll(FORM)) count(form(m[0]), form(rename(m[0])));
  const renamed = restore(rename(text));
  for (const h of findHits(renamed, rules)) left.push(`${file}:${h.line}: "${h.match}"`);
  if (renamed !== restore(masked)) changed.push([file, renamed]);
}

if (left.length) {
  for (const l of left) console.log(`left for a person: ${l}`);
  console.log(`${left.length} spellings the script does not rename; nothing written`);
  process.exit(1);
}
for (const [before, { to, count }] of [...forms].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) {
  console.log(`${String(count).padStart(5)}  ${before} → ${to}`);
}
if (check) {
  console.log(changed.length ? `${changed.length} files still to rename` : "nothing to rename");
  process.exit(changed.length ? 1 : 0);
}
for (const [file, text] of changed) writeFileSync(path.join(ROOT, file), text);
console.log(`${changed.length} files renamed`);
