// Throwaway repositories and trees for the verify self-tests: each test builds the smallest fixture that
// shows one rule catching one violation.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";

/** A fresh directory, removed when the test file finishes. */
export function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "amp-verify-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function write(root: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
}

/** A git repository with one commit per entry of `commits`; returns the commit SHAs in order. */
export function repo(root: string, commits: Array<Record<string, string>>): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const shas: string[] = [];
  for (const [i, files] of commits.entries()) {
    write(root, files);
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", `commit ${i}`);
    shas.push(git("rev-parse", "HEAD"));
  }
  return shas;
}

/** A log that keeps its lines in memory. */
export function memoryLog(root: string) {
  const file = path.join(root, "stage.log");
  writeFileSync(file, "");
  return { file, line: (_: string) => {} };
}
