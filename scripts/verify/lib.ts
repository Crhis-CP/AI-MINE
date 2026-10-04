// Shared helpers for the verify entry point (docs/06-agents/01-parallel-development-rules.md §8): commands
// whose output goes to a stage log, git queries, the path patterns of lanes.yaml and the task cards, and
// hashing. Node built-ins only.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");

/** Runs git in the repository (or `cwd`) and returns stdout without the final newline; throws on failure. */
export function git(args: string[], cwd = ROOT, trimTrailingNewline = true): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  return trimTrailingNewline ? r.stdout.replace(/\n$/, "") : r.stdout;
}

/** Like `git`, but returns null instead of throwing (for refs that may not exist). */
export function tryGit(args: string[], cwd = ROOT, trimTrailingNewline = true): string | null {
  try {
    return git(args, cwd, trimTrailingNewline);
  } catch {
    return null;
  }
}

/** Runs a command and returns its trimmed stdout, or null when it is missing or fails (tool versions). */
export function probe(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const sha256File = (file: string) => sha256(readFileSync(path.resolve(ROOT, file)));

/** One stage's log file: commands append their output to it, the stage adds its own lines. */
export interface Log {
  readonly file: string;
  line(text: string): void;
}

export function openLog(file: string): Log {
  writeFileSync(file, "");
  return { file, line: (text) => appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`) };
}

const running = new Set<ChildProcess>();

/** Stops a child and everything it started (each child runs in its own process group). */
export function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Stops every child still running (on interrupt). */
export function stopAll(): void {
  for (const child of running) stop(child, "SIGKILL");
}

export interface RunOptions {
  log: Log;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

/** A command line for the log, with any password in a URL masked. */
export const shown = (cmd: string, args: string[]) => [cmd, ...args].join(" ").replace(/(:\/\/[^:/@\s]+):[^@\s]+@/g, "$1:***@");

/** Starts a command in the background with stdout and stderr appended to the log. */
export function start(cmd: string, args: string[], opts: RunOptions): ChildProcess {
  opts.log.line(`$ ${shown(cmd, args)}`);
  const fd = openSync(opts.log.file, "a");
  const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env, stdio: ["ignore", fd, fd], detached: true });
  closeSync(fd);
  running.add(child);
  child.on("close", () => running.delete(child));
  return child;
}

/** Runs a command to completion with its output in the log; resolves to the exit code (124 on timeout). */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = start(cmd, args, opts);
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          opts.log.line(`timed out after ${Math.round(opts.timeoutMs! / 1000)} s`);
          stop(child, "SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("error", (e) => opts.log.line(`cannot start ${cmd}: ${e.message}`));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve(timedOut ? 124 : (code ?? 1));
    });
  });
}

/** Runs a command and returns its stdout; stderr goes to the log. For output the stage has to read. */
export function capture(cmd: string, args: string[], opts: RunOptions): Promise<{ code: number; stdout: string }> {
  opts.log.line(`$ ${shown(cmd, args)}`);
  return new Promise((resolve) => {
    const fd = openSync(opts.log.file, "a");
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env, stdio: ["ignore", "pipe", fd], detached: true });
    closeSync(fd);
    running.add(child);
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => chunks.push(b));
    const timer = opts.timeoutMs ? setTimeout(() => stop(child, "SIGKILL"), opts.timeoutMs) : null;
    child.on("error", (e) => opts.log.line(`cannot start ${cmd}: ${e.message}`));
    child.on("close", (code) => {
      running.delete(child);
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/**
 * A path pattern of lanes.yaml or a task card as a RegExp over repository-relative paths: `**` spans
 * directories, `*` and `?` stay inside one path segment, everything else is literal (so `(public)` is a
 * folder name). As in .gitignore, a pattern that matches a directory also covers everything below it.
 */
export function patternRegExp(pattern: string): RegExp {
  const p = pattern
    .trim()
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => patternRegExp(p).test(file));
}
