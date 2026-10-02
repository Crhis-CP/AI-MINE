// names: the upstream name, its brand colours and its ring loader are stopped outside the exception paths,
// in the build output and in what the site serves; upstream brand assets are stopped everywhere. The
// patterns come from names.json, so this file never spells them out.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { checkNames, checkOutputs, checkOutputTree, exemption, loadRules } from "../names.ts";
import { scratch, write } from "./helpers.ts";

const rules = loadRules();
const [N, SPACED] = rules.names as [string, string];
const [COLOUR, , RING] = rules.marks as [string, string, string];
const LOGO = "upstream logo bytes";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A tree with the brand manifest (one asset) and `files`; returns the root and its file list. */
function tree(files: Record<string, string>): { dir: string; files: string[] } {
  const dir = scratch();
  const all = {
    [rules.brand.manifest]: JSON.stringify({ files: [{ path: `${rules.brand.prefixes[0]}logo.svg`, sha256: sha(LOGO) }] }),
    ...files,
  };
  write(dir, all);
  return { dir, files: Object.keys(all) };
}

test("the name outside the exceptions is stopped; on an exception path, or as a reference to a handoff file, it is not", () => {
  const { dir, files } = tree({
    "apps/web/app/lib/keys.ts": `export const THEME = "${N}-theme";\nexport const NEXT = 1;\n`,
    NOTICE: `Built on ${N.toUpperCase()}.\n`,
    "docs/04-architecture/notes.md": `${N}\n`,
    "tasks/TASK-0009.md": `${N}\n`,
    "scripts/baseline/run.sh": `# see docs/04-architecture/04-${N}-adoption.md 7.3 and upstream/${N}.lock.json\n`,
  });
  assert.deepEqual(checkNames(dir, files, rules), [`apps/web/app/lib/keys.ts:1: "${N}" outside the exception paths of scripts/verify/names.json`]);
});

test("the spaced name and the marks are caught in any case, and in binary files", () => {
  const { dir, files } = tree({
    "README.md": `intro\n\n${SPACED.toUpperCase()} framework\n`,
    "apps/web/app/app.css": `a {\n  color: ${COLOUR.toUpperCase()};\n}\n`,
    "apps/web/app/root.tsx": `<${RING} size={12} />\n`,
    "industry/brand/icon.png": `\u0000PNG\u0000${N}\u0000`,
  });
  assert.deepEqual(checkNames(dir, files, rules).sort(), [
    `README.md:3: "${SPACED.toUpperCase()}" outside the exception paths of scripts/verify/names.json`,
    `apps/web/app/app.css:2: "${COLOUR.toUpperCase()}" outside the exception paths of scripts/verify/names.json`,
    `apps/web/app/root.tsx:1: "${RING}" outside the exception paths of scripts/verify/names.json`,
    `industry/brand/icon.png:1: "${N}" outside the exception paths of scripts/verify/names.json`,
  ]);
});

test("a governance file is covered only while it is byte-identical to its handoff template", () => {
  const template = `# rules\n${N} is the base.\n`;
  const same = tree({ "docs/06-agents/templates/root-AGENTS.md": template, "AGENTS.md": template });
  assert.deepEqual(checkNames(same.dir, same.files, rules), []);
  assert.equal(exemption(same.dir, "AGENTS.md", rules), "4 governance records");
  const edited = tree({ "docs/06-agents/templates/root-AGENTS.md": template, "AGENTS.md": `${template}one more line\n` });
  assert.deepEqual(checkNames(edited.dir, edited.files, rules), [
    `AGENTS.md:2: "${N}" outside the exception paths of scripts/verify/names.json`,
    "AGENTS.md: differs from docs/06-agents/templates/root-AGENTS.md, so the governance exception does not cover it",
  ]);
});

test("an upstream brand asset is stopped wherever it is, and a path that names the project is stopped", () => {
  const { dir, files } = tree({
    "docs/assets/banner.svg": LOGO,
    "apps/web/public/mark.svg": LOGO,
    [`apps/web/app/${N}.ts`]: "export {};\n",
  });
  assert.deepEqual(checkNames(dir, files, rules).sort(), [
    `apps/web/app/${N}.ts: the path contains "${N}"`,
    `apps/web/public/mark.svg: same bytes as the upstream brand asset ${rules.brand.prefixes[0]}logo.svg (no exceptions)`,
    `docs/assets/banner.svg: same bytes as the upstream brand asset ${rules.brand.prefixes[0]}logo.svg (no exceptions)`,
  ]);
});

test("the build output and the site's outputs have no exceptions", () => {
  const { dir } = tree({
    "apps/web/build/client/assets/root.css": `@keyframes ${N}-fade{to{opacity:0}}`,
    "apps/web/build/client/logo.svg": LOGO,
    "apps/web/build/server/index.js": "export default {};\n",
  });
  assert.deepEqual(checkOutputTree(path.join(dir, "apps/web/build"), dir, rules).sort(), [
    `apps/web/build/client/assets/root.css:1: "${N}" in the build output`,
    `apps/web/build/client/logo.svg: same bytes as the upstream brand asset ${rules.brand.prefixes[0]}logo.svg`,
  ]);
  assert.deepEqual(
    checkOutputs(
      [
        { label: "/llms.txt (HTTP 200)", text: `# Site\n\nRuns on ${N.toUpperCase()}.\n` },
        { label: "/feed.xml (HTTP 200)", text: "<rss/>" },
      ],
      rules,
    ),
    [`/llms.txt (HTTP 200), line 3: "${N.toUpperCase()}"`],
  );
});
