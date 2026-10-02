// Stage `toolchain` (T-0001): the repository rules that keep installs and images reproducible and keep
// GitHub Actions off (docs/07-bootstrap/01-new-repo-bootstrap.md §4 T-0001; docs/04-architecture/
// 02-tech-stack.md 7.2; docs/04-architecture/06-security-and-access.md 6.1):
//   - pnpm only: `packageManager` pinned to an exact version, one pnpm-lock.yaml, no npm/yarn/bun lockfile;
//   - pnpm-workspace.yaml keeps the one-day release delay and an explicit allowBuilds list;
//   - the Dockerfile installs with --frozen-lockfile, keeps the NPM_REGISTRY build argument and never uses
//     `pnpm deploy` (it breaks Node's type stripping of the workspace packages);
//   - every base image is pinned to a patch version and its sha256 digest;
//   - nothing under .github/workflows (verification runs through `make verify`, ADR-0017).
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { git, ROOT } from "./lib.ts";

// The full release version (PostgreSQL's is major.minor, e.g. 17.11; most others are x.y.z) plus the digest.
const PINNED_IMAGE = /^[\w./-]+:\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?@sha256:[0-9a-f]{64}$/;
const OTHER_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"]);
const MIN_RELEASE_AGE_MINUTES = 1440;

const isDockerfile = (f: string) => /(^|\/)Dockerfile[^/]*$|\.dockerfile$/i.test(f);
const isComposeFile = (f: string) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(f);

/** Problems with the repository's toolchain rules; `files` are the tracked paths under `root`. */
export function checkToolchain(root: string, files: readonly string[]): string[] {
  const problems: string[] = [];
  const read = (f: string) => readFileSync(path.join(root, f), "utf8");
  const tracked = files.filter((f) => !f.startsWith("docs/"));

  const pkg = JSON.parse(read("package.json")) as { packageManager?: string; engines?: { node?: string } };
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? "")) {
    problems.push(`package.json: packageManager must pin an exact pnpm version (got "${pkg.packageManager ?? ""}")`);
  }
  if (!pkg.engines?.node) problems.push("package.json: engines.node is missing");

  for (const f of tracked) {
    const base = path.posix.basename(f);
    if (OTHER_LOCKFILES.has(base)) problems.push(`${f}: only pnpm-lock.yaml is allowed (one lockfile, pnpm 12)`);
    if (base === "pnpm-lock.yaml" && f !== "pnpm-lock.yaml") problems.push(`${f}: the workspace has one lockfile, at the root`);
    if (f.startsWith(".github/workflows/")) {
      problems.push(`${f}: GitHub Actions stay off (ADR-0017); checks run through make verify — move the file out of .github/workflows`);
    }
  }
  if (!files.includes("pnpm-lock.yaml")) problems.push("pnpm-lock.yaml is missing");

  const ws = (parse(read("pnpm-workspace.yaml")) ?? {}) as { minimumReleaseAge?: unknown; allowBuilds?: unknown };
  if (typeof ws.minimumReleaseAge !== "number" || ws.minimumReleaseAge < MIN_RELEASE_AGE_MINUTES) {
    problems.push(`pnpm-workspace.yaml: minimumReleaseAge must be at least ${MIN_RELEASE_AGE_MINUTES} minutes`);
  }
  if (typeof ws.allowBuilds !== "object" || ws.allowBuilds === null || Array.isArray(ws.allowBuilds)) {
    problems.push("pnpm-workspace.yaml: allowBuilds must be an explicit mapping (empty when no dependency needs install scripts)");
  }

  for (const f of tracked.filter(isDockerfile)) {
    const text = read(f);
    const lines = text.split("\n");
    const instructions = lines.filter((l) => !/^\s*#/.test(l)).join("\n");
    if (/\bpnpm\b[^\n]*\bdeploy\b/.test(instructions)) problems.push(`${f}: \`pnpm deploy\` is not allowed (copy the repository and run pnpm install --prod)`);
    if (!/^\s*ARG\s+NPM_REGISTRY\b/m.test(instructions)) problems.push(`${f}: keep the NPM_REGISTRY build argument`);
    for (const line of instructions.split("\n").filter((l) => /\bpnpm\s+install\b/.test(l))) {
      if (!line.includes("--frozen-lockfile")) problems.push(`${f}: pnpm install without --frozen-lockfile: ${line.trim()}`);
    }
    const stages = new Set<string>();
    for (const line of lines) {
      const m = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i);
      if (!m) continue;
      const image = m[1];
      if (!stages.has(image.toLowerCase()) && image !== "scratch" && !PINNED_IMAGE.test(image)) {
        problems.push(`${f}: base image must name a patch version and its sha256 digest: ${image}`);
      }
      if (m[2]) stages.add(m[2].toLowerCase());
    }
  }

  for (const f of tracked.filter(isComposeFile)) {
    const doc = (parse(read(f), { merge: true }) ?? {}) as { services?: Record<string, { image?: string; build?: unknown }> };
    for (const [name, service] of Object.entries(doc.services ?? {})) {
      // A service that is built here names the local image tag it builds; only pulled images need a digest.
      if (service?.image && service.build === undefined && !PINNED_IMAGE.test(service.image)) {
        problems.push(`${f}: service ${name}: image must name a patch version and its sha256 digest: ${service.image}`);
      }
    }
  }
  return problems;
}

/** Problems with the tools this run uses: Node within package.json's engines, pnpm at packageManager. */
export function checkRuntime(pnpmVersion: string | null, root = ROOT): string[] {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { packageManager?: string; engines?: { node?: string } };
  const problems: string[] = [];
  const want = pkg.packageManager?.replace(/^pnpm@/, "");
  if (pnpmVersion !== want) problems.push(`pnpm ${pnpmVersion ?? "(not found)"} is running; package.json pins pnpm ${want}`);
  const min = pkg.engines?.node?.match(/^>=\s*(\d+)(?:\.(\d+))?/);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (min && (major < Number(min[1]) || (major === Number(min[1]) && minor < Number(min[2] ?? 0)))) {
    problems.push(`Node ${process.versions.node} is older than engines.node ${pkg.engines?.node}`);
  }
  return problems;
}

/** Tracked paths as they are (`-z`: no quoting of non-ASCII or special characters). */
export const trackedFiles = (root = ROOT) => git(["ls-files", "-z"], root).split("\0").filter(Boolean);
