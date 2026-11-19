// The entry documents an agent reads first (AGENTS.md, CLAUDE.md, the system map) name only paths that exist.
// November 2026: the rule file named nine directories, branches and modules that were not there, and a reader
// could not tell which lines to trust.
//
// A path is a back-quoted token that starts with a top-level directory of the repository, or names a file at
// its root. Tokens with a placeholder (`tasks/TASK-nnnn.md`, `tests/<file>.test.ts`), commands and URLs are
// not paths. `*` is a wildcard: something must match. A path followed by “（未建）” is planned: it must not
// exist yet, so the mark comes off in the change that creates it.
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.ts";

export const ENTRY_DOCUMENTS = ["AGENTS.md", "CLAUDE.md", "docs/04-architecture/03-module-map.md"];
const PLANNED = "（未建）";

/** The back-quoted tokens of `text` that claim to be repository paths, with the line each is on. */
export function pathClaims(text: string, topLevel: ReadonlySet<string>): Array<{ line: number; path: string; planned: boolean }> {
  const out: Array<{ line: number; path: string; planned: boolean }> = [];
  let fenced = false;
  for (const [i, line] of text.split("\n").entries()) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const token = m[1]!.replace(/\/$/, "");
      if (/[\s<>…]|nnnn/.test(token) || token.startsWith("/") || token.includes("://")) continue;
      if (!topLevel.has(token.split("/")[0]!)) continue;
      out.push({ line: i + 1, path: token, planned: line.slice(m.index! + m[0].length).startsWith(PLANNED) });
    }
  }
  return out;
}

/** Every claim of the entry documents that the repository does not bear out. */
export function checkEntryPaths(root = ROOT, documents = ENTRY_DOCUMENTS): string[] {
  const topLevel = new Set(readdirSync(root));
  const problems: string[] = [];
  for (const doc of documents) {
    if (!existsSync(path.join(root, doc))) {
      problems.push(`${doc}: the entry document is missing`);
      continue;
    }
    for (const claim of pathClaims(readFileSync(path.join(root, doc), "utf8"), topLevel)) {
      const exists = claim.path.includes("*") ? globSync(claim.path, { cwd: root }).length > 0 : existsSync(path.join(root, claim.path));
      if (claim.planned && exists) problems.push(`${doc}:${claim.line}: ${claim.path} exists now: remove “${PLANNED}”`);
      if (!claim.planned && !exists) problems.push(`${doc}:${claim.line}: ${claim.path} does not exist`);
    }
  }
  return problems;
}
