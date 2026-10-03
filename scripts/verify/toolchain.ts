// Stage `toolchain` (T-0001): the repository rules that keep installs and images reproducible and keep
// GitHub Actions to one executor of make verify (docs/07-bootstrap/01-new-repo-bootstrap.md §4 T-0001;
// docs/04-architecture/02-tech-stack.md 7.2; docs/04-architecture/06-security-and-access.md 6.1):
//   - pnpm only: `packageManager` pinned to an exact version, one pnpm-lock.yaml, no npm/yarn/bun lockfile;
//   - pnpm-workspace.yaml keeps the one-day release delay and an explicit allowBuilds list;
//   - the Dockerfile installs with --frozen-lockfile, keeps the NPM_REGISTRY build argument and never uses
//     `pnpm deploy` (it breaks Node's type stripping of the workspace packages);
//   - every base image is pinned to a patch version and its sha256 digest;
//   - under .github/workflows only verify.yml, in the shape workflowProblems() checks (TASK-0015): the Owner
//     kept GitHub Actions on for the public repository (2026-10-03, 08-owner-voice DEC-25 ③), and by
//     ADR-0017's reversal clause a hosted CI is one more executor of `make verify`, never a gate or a release
//     path. The file may also be absent: nothing asserts that a CI workflow exists (rules file 8.1).
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { git, ROOT } from "./lib.ts";

// The full release version (PostgreSQL's is major.minor, e.g. 17.11; most others are x.y.z) plus the digest.
export const PINNED_IMAGE = /^[\w./-]+:\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?@sha256:[0-9a-f]{64}$/;
/** The one workflow file allowed (TASK-0015). */
export const WORKFLOW = ".github/workflows/verify.yml";
const PR_TYPES = new Set(["opened", "synchronize", "reopened", "edited"]);
const ALLOWED_ACTION = /^actions\/(?:checkout|setup-node)@[0-9a-f]{40}$/;
const HOSTED_UBUNTU = /^ubuntu-\d+\.\d+$/;
const PUBLIC_ONLY = "github.event.repository.visibility == 'public'";
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, compared as text
const CANCEL_PULL_REQUESTS_ONLY = "${{ github.event_name == 'pull_request' }}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, compared as text
const GROUP = "verify-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}";
const VERIFY_STEP = 'make verify SHA="$HEAD_SHA"';
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
      problems.push(
        ...(f === WORKFLOW
          ? workflowProblems(f, read(f))
          : [`${f}: the only workflow is ${WORKFLOW}, which runs make verify (ADR-0017; TASK-0015); move this file out of .github/workflows`]),
      );
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

type Mapping = Record<string, unknown>;
const mapping = (v: unknown): Mapping => (v && typeof v === "object" && !Array.isArray(v) ? (v as Mapping) : {});
const isMapping = (v: unknown) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Problems with the verify workflow, rule by rule as TASK-0015 lists them: (2) triggered only by pull requests
 * (opened, synchronize, reopened, edited), pushes to main and by hand; (3) a run pushed to main is never
 * cancelled or replaced; (4) read-only for the whole run; (5) only actions/checkout and actions/setup-node,
 * pinned to a full commit SHA, and no reusable workflow; (6) checkout keeps no credentials; (7) no secrets
 * and no token, however an expression is written; (8) no `${{ }}` inside a script; (9) nothing allowed to fail
 * quietly, no deployment environment; (10) a time limit and a GitHub-hosted Ubuntu image of a named version;
 * (11) public repository only; (12) no service or job container: the database comes from
 * scripts/verify/ci-db.ts, whose image is docker-compose.yml's; (13) a step runs make verify, alone and
 * unconditionally. Rule 1 (no other workflow file) is in checkToolchain.
 */
export function workflowProblems(f: string, text: string): string[] {
  const out: string[] = [];
  const bad = (what: string) => out.push(`${f}: ${what}`);
  let doc: Mapping;
  try {
    doc = mapping(parse(text));
  } catch (e) {
    return [`${f}: not valid YAML (${(e as Error).message.split("\n")[0]})`];
  }

  // (2) YAML 1.2, the yaml package's default, reads the key `on` as a string, not as the boolean true.
  if (!isMapping(doc.on)) bad("on must be a mapping of pull_request, push and workflow_dispatch");
  const on = mapping(doc.on);
  for (const [trigger, value] of Object.entries(on)) {
    const settings = mapping(value);
    if (trigger === "pull_request") {
      const extra = Object.keys(settings).filter((k) => k !== "types");
      const types = settings.types === undefined ? [] : Array.isArray(settings.types) ? settings.types.map(String) : [String(settings.types)];
      if (extra.length || types.some((t) => !PR_TYPES.has(t))) bad("pull_request may only list types opened, synchronize, reopened and edited");
    } else if (trigger === "push") {
      const branches = settings.branches;
      const onlyMain = Array.isArray(branches) && branches.length === 1 && branches[0] === "main";
      if (!onlyMain || Object.keys(settings).some((k) => k !== "branches")) bad("push may trigger it only for main (on.push.branches: [main], nothing else)");
    } else if (trigger === "workflow_dispatch") {
      const inputs = Object.keys(mapping(settings.inputs));
      if (Object.keys(settings).some((k) => k !== "inputs") || inputs.some((k) => k !== "task")) bad("workflow_dispatch may only take the input task");
    } else {
      bad(`trigger ${trigger} is not allowed (only pull_request, push to main and workflow_dispatch)`);
    }
  }

  // (3) Within one concurrency group a newer queued run replaces an older queued one, cancel-in-progress or not.
  const concurrency = (at: string, value: unknown) => {
    if (value === undefined) return;
    const c = isMapping(value) ? mapping(value) : { group: value };
    const cancel = c["cancel-in-progress"];
    if (cancel !== undefined && cancel !== false && cancel !== CANCEL_PULL_REQUESTS_ONLY) {
      bad(`${at}cancel-in-progress may cancel a run pushed to main; use ${CANCEL_PULL_REQUESTS_ONLY}`);
    }
    if (c.group !== GROUP) bad(`${at}the concurrency group must be ${GROUP}, so a run pushed to main is never replaced`);
  };
  concurrency("", doc.concurrency);

  // (4)
  if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: "read" })) bad("permissions must be exactly { contents: read }");
  // (7) Every expression in the file's strings, keys included, string literals left out.
  const code = strings(doc)
    .flatMap(expressions)
    .map((e) => e.replace(/'(?:[^']|'')*'/g, "''"));
  if (code.some((e) => /\bsecrets\b/i.test(e))) bad("reads secrets; the verify workflow has none");
  if (code.some(readsToken)) bad("passes the GitHub token on; the verify workflow needs none");

  let runsDatabase = false;
  let runsVerify = false;
  const jobs = Object.entries(mapping(doc.jobs));
  if (!jobs.length) bad("has no jobs");
  for (const [name, value] of jobs) {
    const job = mapping(value);
    const at = `job ${name}: `;
    if ("uses" in job) bad(`${at}uses a reusable workflow; only steps of this file may run`); // (5)
    if ("permissions" in job) bad(`${at}permissions are set once, for the whole workflow`); // (4)
    if ("secrets" in job) bad(`${at}secrets are not allowed`); // (7)
    if ("continue-on-error" in job) bad(`${at}continue-on-error is not allowed`); // (9)
    if ("environment" in job) bad(`${at}a deployment environment is not allowed`); // (9)
    if (typeof job["timeout-minutes"] !== "number") bad(`${at}needs timeout-minutes`); // (10)
    if (typeof job["runs-on"] !== "string" || !HOSTED_UBUNTU.test(job["runs-on"])) {
      bad(`${at}runs-on must be a GitHub-hosted Ubuntu image with its version (e.g. ubuntu-24.04), not ${JSON.stringify(job["runs-on"])}`);
    }
    const condition = String(job.if ?? "")
      .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1")
      .trim();
    if (condition !== PUBLIC_ONLY) bad(`${at}needs the condition if: ${PUBLIC_ONLY} (Actions is free for public repositories only)`); // (11)
    concurrency(at, job.concurrency); // (3)
    if ("services" in job) bad(`${at}service containers are not allowed; scripts/verify/ci-db.ts starts the database from docker-compose.yml's image`); // (12)
    if ("container" in job) bad(`${at}a job container is not allowed`); // (12)
    for (const [i, s] of (Array.isArray(job.steps) ? job.steps : []).entries()) {
      const step = mapping(s);
      const label = `${at}step ${i + 1}: `;
      if ("uses" in step) {
        const uses = String(step.uses);
        if (!ALLOWED_ACTION.test(uses)) bad(`${label}${uses}: only actions/checkout and actions/setup-node, pinned to a full commit SHA`); // (5)
        if (uses.startsWith("actions/checkout@") && mapping(step.with)["persist-credentials"] !== false) {
          bad(`${label}actions/checkout must set persist-credentials: false`); // (6)
        }
      }
      if ("continue-on-error" in step) bad(`${label}continue-on-error is not allowed`); // (9)
      if (typeof step.run === "string") {
        if (step.run.includes("${{")) bad(`${label}\${{ … }} inside run; pass the value through env`); // (8)
        if (/(^|[\s;&|(])node scripts\/verify\/ci-db\.ts(\s|$)/m.test(step.run)) runsDatabase = true;
        if (step.run.trim() === VERIFY_STEP && !("if" in step)) runsVerify = true; // (13): nothing masks or skips it
      }
    }
  }
  if (!runsDatabase) bad("no step runs node scripts/verify/ci-db.ts (the database image comes from docker-compose.yml)"); // (12)
  if (!runsVerify) bad(`no step runs ${VERIFY_STEP} alone and unconditionally (the workflow is an executor of make verify and nothing else)`); // (13)
  return out;
}

/** Every string in a parsed YAML value, mapping keys included. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return isMapping(value) ? Object.entries(mapping(value)).flatMap(([k, v]) => [k, ...strings(v)]) : [];
}

/** The `${{ … }}` expressions in a string, found as GitHub finds them: each ends at the first `}}` outside a '…' literal. */
function expressions(s: string): string[] {
  const out: string[] = [];
  for (let at = s.indexOf("${{"); at !== -1; ) {
    let inLiteral = false;
    let end = s.length;
    for (let i = at + 3; i < s.length - 1; i++) {
      if (s[i] === "'") inLiteral = !inLiteral;
      else if (!inLiteral && s[i] === "}" && s[i + 1] === "}") {
        end = i;
        break;
      }
    }
    out.push(s.slice(at + 3, end));
    at = s.indexOf("${{", end + 2);
  }
  return out;
}

/** `github` other than as github.<a property other than token>: github.token, github['token'] and the whole context
 * (toJSON(github), github.*: the token is one of its properties) all hand the token on. Names match in any case. */
const readsToken = (code: string) => [...code.matchAll(/\bgithub\b(?:\s*\.\s*([A-Za-z_][\w-]*))?/gi)].some((m) => !m[1] || m[1].toLowerCase() === "token");

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
