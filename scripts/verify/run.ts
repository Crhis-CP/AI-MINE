// make verify (docs/06-agents/01-parallel-development-rules.md §8; ADR-0017): every check that needs no real
// model, run on a clean checkout of one commit, ending in a receipt bound to that commit. Any executor can run
// it; no hosted CI is involved. The two jobs of the upstream workflow (scripts/verify/upstream-check.yml) are
// translated step by step: install, typecheck, build-web, web tests, migrations, smoke, backend tests,
// compose-smoke.
//   node scripts/verify/run.ts [--task TASK-nnnn] [--sha <40 hex>] [--only a,b] [--skip a,b] [--allow-dirty]
//   node scripts/verify/run.ts --quick          pnpm check: the fast subset, no receipt
// Environment (nothing else from the caller's environment reaches the checks, see childEnv):
//   VERIFY_DATABASE_URL  PostgreSQL database named *_ci or *_test, dropped and recreated (default DATABASE_URL)
//   VERIFY_BASE          ref the change is compared with (default origin/main, else main)
//   VERIFY_TASK          task card, when the branch name does not say (agent/<lane>/TASK-nnnn-<slug>)
//   VERIFY_EXECUTOR_ID   a name for this executor in the receipt (never the host name)
//   VERIFY_SKIP          stages to skip, comma-separated (e.g. compose-smoke where Docker cannot pull images)
//   VERIFY_PASS_ENV      extra variable names the checks may see, comma-separated
//   VERIFY_WEB_PORT / VERIFY_API_PORT   ports for the smoke check (default 3000 / 3001)
// A stage that is skipped, for any reason, makes the receipt `scope: focused`: it records what ran and cannot
// be used to merge.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkBoundaries } from "./boundaries.ts";
import { git, type Log, openLog, probe, ROOT, run, capture, sha256, sha256File, start, stop, stopAll, tryGit } from "./lib.ts";
import { formatLint } from "./lint.ts";
import { checkNames, checkOutputs, checkOutputTree, fetchSiteOutputs } from "./names.ts";
import { cardFromBranch, pathGuard } from "./path-guard.ts";
import { scanSecrets, type SecretScan } from "./secrets.ts";
import { checkTasks } from "./tasks.ts";
import { checkRuntime, checkToolchain, trackedFiles } from "./toolchain.ts";

const WEB_PACKAGE = "@amp/web";
const PENDING_STAGES = [
  "contracts (TASK-0005)",
  "data-ownership, role-config (TASK-0004)",
  "e2e-smoke (TASK-0008)",
  "product-update",
  "pit-checks (TASK-0011)",
];
const PASS_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "PNPM_HOME",
  "npm_config_registry",
];

type Status = "pass" | "fail" | "skipped";
interface Outcome {
  status: Status;
  note?: string;
}
interface Db {
  url: string;
  name: string;
}
interface Ctx {
  log: Log;
  head: string;
  base: string | null;
  task: string | null;
  db: Db | null;
  quick: boolean;
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
}
interface Stage {
  name: string;
  quick?: boolean;
  after?: string[];
  needsDb?: boolean;
  run: (ctx: Ctx) => Promise<Outcome>;
}

// ---------- arguments and environment ----------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

if (flag("--release-check") || flag("--nightly")) {
  // Skeletons (rules §8.1): they must not pass by accident while their stages do not exist.
  const what = flag("--nightly")
    ? "make nightly: full E2E (TASK-0008) and capacity benchmarks (TASK-0012) — not implemented yet"
    : "make release-check: artifact build, image scan, SBOM, signing, capacity and smoke (TASK-0009) — not implemented yet";
  console.error(what);
  process.exit(2);
}

const quick = flag("--quick");
const allowDirty = flag("--allow-dirty");
const only = list(option("--only"));
const skip = [...list(option("--skip")), ...list(process.env.VERIFY_SKIP)];
const passEnv = [...PASS_ENV, ...list(process.env.VERIFY_PASS_ENV)];
const webPort = Number(process.env.VERIFY_WEB_PORT || 3000);
const apiPort = Number(process.env.VERIFY_API_PORT || 3001);

/** The environment the checks run with: an allowlist of the caller's variables plus what the stage sets. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", TZ: "UTC" };
  for (const k of passEnv) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** psql connection variables for a database URL (so no password appears on a command line). */
function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  };
}

function databaseFromEnv(): Db | null {
  const url = process.env.VERIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) return null;
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/_(ci|test)$/.test(name)) {
    console.error(`refusing to run: the verify database must be named *_ci or *_test (got "${name}"); it is dropped and recreated`);
    process.exit(2);
  }
  return { url, name };
}

/** A sibling database for a second, independent check (`amp_ci` → `amp_seed_ci`). */
const sibling = (db: Db, label: string): Db => {
  const name = db.name.replace(/_(ci|test)$/, `_${label}_$1`);
  const u = new URL(db.url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return { url: u.toString(), name };
};

async function recreate(db: Db, log: Log): Promise<boolean> {
  const env = childEnv({ ...pgEnv(db.url), PGDATABASE: "postgres" });
  const quoted = `"${db.name.replaceAll('"', '""')}"`;
  return (
    (await run("psql", ["-qX", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`, "-c", `CREATE DATABASE ${quoted}`], {
      log,
      env,
    })) === 0
  );
}

async function dropDb(db: Db, log: Log): Promise<void> {
  const env = childEnv({ ...pgEnv(db.url), PGDATABASE: "postgres" });
  await run("psql", ["-qX", "-c", `DROP DATABASE IF EXISTS "${db.name.replaceAll('"', '""')}" WITH (FORCE)`], { log, env });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

const fail = (note: string): Outcome => ({ status: "fail", note });
const pass = (note?: string): Outcome => ({ status: "pass", note });
const fromCode = (code: number, what: string): Outcome => (code === 0 ? pass() : fail(`${what} exited with ${code}`));
const problems = (lines: string[], log: Log, ok: string): Outcome => {
  for (const l of lines) log.line(l);
  return lines.length ? fail(lines.length === 1 ? lines[0] : `${lines.length} problems (first: ${lines[0]})`) : pass(ok);
};

/** Settings the site needs in the smoke check and the backend tests (as the upstream workflow sets them). */
function siteEnv(db: Db): Record<string, string> {
  return {
    DATABASE_URL: db.url,
    SITE_URL: `http://127.0.0.1:${webPort}`,
    API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    WEB_PORT: String(webPort),
    API_PORT: String(apiPort),
    SESSION_SECRET: randomBytes(24).toString("hex"),
    IMG_PROXY_SIGN_SECRET: randomBytes(24).toString("hex"),
  };
}

const industrySourceCount = (root: string) =>
  (JSON.parse(readFileSync(path.join(root, "industry/sources.json"), "utf8")) as { sources: unknown[] }).sources.length;

const receipt: Record<string, unknown> = {};

// ---------- stages ----------

const STAGES: Stage[] = [
  {
    name: "install",
    run: async ({ log, env }) => {
      const before = sha256File("pnpm-lock.yaml");
      const code = await run("pnpm", ["install", "--frozen-lockfile"], { log, env: env(), timeoutMs: 15 * 60_000 });
      if (code !== 0) return fail(`pnpm install --frozen-lockfile exited with ${code}`);
      return sha256File("pnpm-lock.yaml") === before ? pass() : fail("pnpm install changed pnpm-lock.yaml");
    },
  },
  {
    name: "toolchain",
    quick: true,
    run: async ({ log }) =>
      problems([...checkToolchain(ROOT, trackedFiles()), ...checkRuntime(probe("pnpm", ["--version"]))], log, "pins, lockfile, images, no workflows"),
  },
  {
    name: "format-lint",
    quick: true,
    after: ["install"],
    run: async ({ log, env }) => problems(await formatLint(log, env()), log, "biome ci; warnings at baseline"),
  },
  {
    name: "typecheck",
    quick: true,
    after: ["install"],
    run: async ({ log, env }) => fromCode(await run("pnpm", ["typecheck"], { log, env: env() }), "pnpm typecheck"),
  },
  { name: "boundaries", quick: true, run: async ({ log }) => problems(checkBoundaries(ROOT, trackedFiles()), log, "workspace graph and imports") },
  {
    name: "names",
    quick: true,
    run: async ({ log }) => problems(checkNames(ROOT, trackedFiles()), log, "upstream name and marks only on the exception paths; no upstream brand asset"),
  },
  {
    name: "path-guard",
    run: async ({ log, base, head, task }) => {
      if (!base) return { status: "skipped", note: "no base ref to compare with (set VERIFY_BASE)" };
      const r = pathGuard(base, head, task);
      for (const l of r.lines) log.line(l);
      return { status: r.status, note: r.lines.length === 1 ? r.lines[0] : `${r.lines.length} lines in the log` };
    },
  },
  {
    name: "secrets",
    run: async ({ log, env, base, head }) => {
      // The change's own commits; on the base itself (main after a merge), its last commit.
      const from = base && base !== head ? base : tryGit(["rev-parse", "--verify", "-q", `${head}^`]);
      const scan: SecretScan = await scanSecrets(from, head, log, env());
      receipt.secret_scan = scan;
      return scan.findings ? fail(`${scan.findings} possible secrets (see the log for file and line)`) : pass(`${scan.range}: 0 findings`);
    },
  },
  {
    name: "audit",
    after: ["install"],
    run: async ({ log, env }) => {
      const r = await capture("pnpm", ["audit", "--audit-level=high", "--json"], { log, env: env(), timeoutMs: 5 * 60_000 });
      let v: Record<string, number>;
      try {
        v = (JSON.parse(r.stdout) as { metadata: { vulnerabilities: Record<string, number> } }).metadata.vulnerabilities;
      } catch {
        return fail(`pnpm audit gave no report (exit ${r.code}); the advisory service may be unreachable from this executor`);
      }
      receipt.audit = {
        tool: "pnpm audit --audit-level=high",
        version: probe("pnpm", ["--version"]),
        datasource: `${probe("pnpm", ["config", "get", "registry"]) ?? "npm registry"} (bulk advisory endpoint)`,
        date: new Date().toISOString().slice(0, 10),
        vulnerabilities: v,
      };
      log.line(JSON.stringify(v));
      const blocking = (v.high ?? 0) + (v.critical ?? 0);
      return blocking
        ? fail(`${blocking} high or critical advisories (dependency-only PR route: rules §8.2)`)
        : pass(`0 high or critical (${v.moderate ?? 0} moderate, ${v.low ?? 0} low)`);
    },
  },
  {
    name: "build-web",
    after: ["install"],
    run: async ({ log, env }) => {
      const code = await run("pnpm", ["--filter", WEB_PACKAGE, "build"], { log, env: env(), timeoutMs: 15 * 60_000 });
      if (code !== 0) return fail(`web build exited with ${code}`);
      return problems(checkOutputTree(path.join(ROOT, "apps/web/build")), log, "no upstream name, mark or brand asset in the build output");
    },
  },
  {
    name: "migrations",
    after: ["install"],
    needsDb: true,
    run: async ({ log, env, db }) => {
      // Empty database: all migrations, then the topics (what the backend tests expect).
      if (!(await recreate(db!, log))) return fail(`could not recreate database ${db!.name}`);
      const e = env({ DATABASE_URL: db!.url });
      if ((await run("node", ["scripts/migrate.ts"], { log, env: e })) !== 0) return fail("migrations failed on an empty database");
      if ((await run("node", ["scripts/seed.ts", "--topics-only"], { log, env: e })) !== 0) return fail("topic seed failed");
      // The full seed on a second empty database: every source in industry/sources.json lands (this replaces
      // the upstream check that there are exactly 18 sources, its demo count).
      const seedDb = sibling(db!, "seed");
      try {
        if (!(await recreate(seedDb, log))) return fail(`could not create database ${seedDb.name}`);
        const se = env({ DATABASE_URL: seedDb.url });
        if ((await run("node", ["scripts/migrate.ts"], { log, env: se })) !== 0) return fail("migrations failed on the seed database");
        if ((await run("node", ["scripts/seed.ts"], { log, env: se })) !== 0) return fail("full seed failed");
        const count = await capture("psql", ["-qXAt", "-c", "select count(*) from sources"], { log, env: env(pgEnv(seedDb.url)) });
        const want = industrySourceCount(ROOT);
        if (Number(count.stdout.trim()) !== want) return fail(`seeded ${count.stdout.trim()} sources, industry/sources.json has ${want}`);
        return pass(`empty-database migrations; ${want} seed sources`);
      } finally {
        await dropDb(seedDb, log);
      }
    },
  },
  {
    name: "smoke",
    after: ["build-web", "migrations"],
    needsDb: true,
    run: async ({ log, env, db }) => {
      for (const port of [webPort, apiPort]) if (!(await portFree(port))) return fail(`port ${port} is in use (set VERIFY_WEB_PORT / VERIFY_API_PORT)`);
      // The site runs with collection and model calls off, as in the upstream workflow.
      const e = env({ ...siteEnv(db!), COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" });
      const api = start("node", ["apps/api/src/main.ts"], { log, env: e });
      const web = start("node", ["server.ts"], { log, env: { ...e, NODE_ENV: "production" }, cwd: path.join(ROOT, "apps/web") });
      const base = `http://127.0.0.1:${webPort}`;
      try {
        if (!(await waitFor(`${base}/api/health`, 60))) return fail("the site did not answer /api/health within 60 s");
        if ((await run("node", ["scripts/smoke.ts", "--base", base], { log, env: e })) !== 0) return fail("smoke check failed");
        // The official MCP client (it calls get_story only when the hot list has a story, so not on this empty
        // database), then the name check on what readers and machines get: whole answers, every MCP tool
        // called once (TASK-0003 :126).
        const mcp = await capture("node", ["scripts/mcp-check.ts", `${base}/api/mcp`], { log, env: e, timeoutMs: 120_000 });
        log.line(mcp.stdout);
        if (mcp.code !== 0) return fail(`MCP check exited with ${mcp.code}`);
        const site = await fetchSiteOutputs(base);
        const outputs = [...site.outputs, { label: "scripts/mcp-check.ts output", text: mcp.stdout }];
        for (const o of outputs) log.line(`name check: ${o.label}, ${o.text.length} characters`);
        return problems(
          [...site.problems, ...checkOutputs(outputs)],
          log,
          `smoke and MCP checks; no upstream name or mark in ${outputs.length} pages and machine outputs`,
        );
      } finally {
        stop(api);
        stop(web);
        await sleep(500);
      }
    },
  },
  {
    name: "test",
    quick: true,
    after: ["install", "build-web"],
    run: async ({ log, env, db, quick }) => {
      const failed: string[] = [];
      if ((await run("node", ["--test", "scripts/verify/tests/*.test.ts"], { log, env: env() })) !== 0) failed.push("verify self-tests");
      // The web tests start the production server, so they need the build (pnpm check runs them when it exists).
      const webTests = !quick || existsSync(path.join(ROOT, "apps/web/build"));
      if (webTests && (await run("node", ["--test", "apps/web/tests/*.test.ts"], { log, env: env() })) !== 0) failed.push("web tests");
      // After the smoke check, which reads an empty database: the backend tests write their own rows.
      if (!quick && db && (await run("pnpm", ["test"], { log, env: env(siteEnv(db)), timeoutMs: 30 * 60_000 })) !== 0) failed.push("backend tests");
      if (failed.length) return fail(`${failed.join(", ")} failed`);
      if (quick) return pass(webTests ? "verify self-tests and web tests" : "verify self-tests (no web build, web tests not run)");
      return db
        ? pass("verify self-tests, web and backend tests")
        : { status: "skipped", note: "verify self-tests and web tests passed; no database for the backend tests" };
    },
  },
  {
    name: "compose-smoke",
    run: async ({ log, env, head }) => {
      if (probe("docker", ["info", "--format", "{{.ServerVersion}}"]) === null || probe("docker", ["compose", "version"]) === null) {
        return { status: "skipped", note: "no Docker on this executor" };
      }
      // A clean export of the commit, so the build never sees a local .env, node_modules or build output.
      const dir = mkdtempSync(path.join(tmpdir(), "amp-verify-"));
      const project = `amp-verify-${head.slice(0, 12)}`;
      const e = env({ PORT: String(webPort), COMPOSE_PROJECT_NAME: project });
      const compose = (...args: string[]) => run("docker", ["compose", "-p", project, ...args], { log, env: e, cwd: dir, timeoutMs: 30 * 60_000 });
      try {
        if (!(await portFree(webPort))) return fail(`port ${webPort} is in use (set VERIFY_WEB_PORT)`);
        const tar = path.join(dir, "..", `${path.basename(dir)}.tar`);
        if ((await run("git", ["archive", "--format=tar", "-o", tar, head], { log, env: e })) !== 0) return fail("git archive failed");
        const x = await run("tar", ["-xf", tar, "-C", dir], { log, env: e });
        rmSync(tar, { force: true });
        if (x !== 0) return fail("could not unpack the export");
        // A throwaway site: nothing is collected and no model is asked (as the upstream docker job does).
        if ((await run("node", ["scripts/init-env.ts", "--llm-key", "ci-not-a-real-key"], { log, env: e, cwd: dir })) !== 0) return fail("init-env failed");
        const dotenv = path.join(dir, ".env");
        const text = readFileSync(dotenv, "utf8")
          .replace(/^COLLECT_ENABLED=.*$/m, "COLLECT_ENABLED=false")
          .replace(/^MODEL_CALLS_ENABLED=.*$/m, "MODEL_CALLS_ENABLED=false");
        writeFileSync(dotenv, `${text}\nMCP_ALLOWED_HOSTS=web\n`);
        if ((await compose("up", "-d", "--build")) !== 0) return fail("docker compose up --build failed");
        if (!(await waitFor(`http://127.0.0.1:${webPort}/api/health`, 180))) return fail("the site did not answer /api/health within 180 s");
        await compose("ps");
        if ((await compose("run", "--rm", "--no-deps", "--entrypoint", "node", "setup", "scripts/smoke.ts", "--base", "http://web:3000")) !== 0) {
          return fail("smoke check inside compose failed");
        }
        const count = await capture(
          "docker",
          ["compose", "-p", project, "exec", "-T", "db", "psql", "-U", "amp", "-d", "amp", "-Atc", "select count(*) from sources"],
          {
            log,
            env: e,
            cwd: dir,
          },
        );
        const want = industrySourceCount(dir);
        if (Number(count.stdout.trim()) !== want) return fail(`compose seeded ${count.stdout.trim()} sources, industry/sources.json has ${want}`);
        return pass(`compose up, smoke, ${want} seed sources`);
      } finally {
        if (existsSync(path.join(dir, "docker-compose.yml"))) {
          await compose("logs", "--tail", "80");
          await compose("down", "-v");
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "docs",
    run: async ({ log, env }) => fromCode(await run("python3", ["scripts/docs-check/validate_package.py", "--strict"], { log, env: env() }), "docs check"),
  },
  {
    name: "tasks",
    run: async ({ log }) => {
      const r = checkTasks();
      return problems(r.problems, log, `${r.cards} task cards`);
    },
  },
];

// ---------- the run ----------

interface TreeState {
  head: string;
  tree: string;
  status: string;
  lockfile: string;
}
const treeState = (): TreeState => ({
  head: git(["rev-parse", "HEAD"]),
  tree: git(["rev-parse", "HEAD^{tree}"]),
  status: git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]),
  lockfile: sha256File("pnpm-lock.yaml"),
});

/** Ways a checkout can show different content than the commit says; each makes the run invalid. */
function tampering(): string[] {
  const out: string[] = [];
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_REPLACE_REF_BASE"]) {
    if (process.env[k]) out.push(`${k} is set`);
  }
  if (git(["for-each-ref", "refs/replace/"])) out.push("replacement objects (refs/replace) are present");
  if (existsSync(path.join(git(["rev-parse", "--git-common-dir"]), "info", "grafts"))) out.push(".git/info/grafts is present");
  const hidden = git(["ls-files", "-v"])
    .split("\n")
    .filter((l) => /^[a-zS] /.test(l));
  if (hidden.length) out.push(`${hidden.length} files are marked assume-unchanged or skip-worktree (first: ${hidden[0].slice(2)})`);
  return out;
}

const startState = treeState();
const head = startState.head;
const problemsAtStart = tampering();
if (problemsAtStart.length) {
  for (const p of problemsAtStart) console.error(`refusing to run: ${p}`);
  process.exit(2);
}
const sha = option("--sha");
if (sha && sha !== head) {
  console.error(`refusing to run: HEAD is ${head}, not the requested ${sha}`);
  process.exit(2);
}
const cleanAtStart = startState.status === "";
if (!cleanAtStart && !quick && !allowDirty) {
  console.error("refusing to run: the checkout has uncommitted or untracked files (commit them, or pass --allow-dirty for a focused run)");
  console.error(startState.status.split("\n").slice(0, 10).join("\n"));
  process.exit(2);
}

const baseRef = process.env.VERIFY_BASE || (tryGit(["rev-parse", "--verify", "-q", "origin/main"]) ? "origin/main" : "main");
const baseHead = tryGit(["rev-parse", "--verify", "-q", baseRef]);
const base = baseHead ? tryGit(["merge-base", baseHead, head]) : null;
const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
const task = option("--task") || process.env.VERIFY_TASK || cardFromBranch(branch);
const db = quick ? null : databaseFromEnv();
const onMain = baseHead === head;

const runId = `${onMain ? "main-" : ""}${head.slice(0, 12)}`;
const logDir = path.join(ROOT, ".verify", "logs", runId);
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });

const selected = STAGES.filter((s) => (quick ? s.quick : true)).filter((s) => !only.length || only.includes(s.name));
const results: Array<{ name: string; status: Status; duration_s: number; note?: string }> = [];
let current = "";
const startedAt = new Date();

function writeReceipt(exitStatus: number, failedStage: string | null, endState: TreeState | null): string {
  const logs = results.map((r, i) => path.join(logDir, `${String(i + 1).padStart(2, "0")}-${r.name}.log`)).filter((f) => existsSync(f));
  const full = !quick && !only.length && results.length === STAGES.length && results.every((r) => r.status !== "skipped") && cleanAtStart;
  const body = {
    receipt_version: 1,
    command: quick ? "pnpm check" : "make verify",
    verify_revision: sha256(git(["ls-files", "-s", "--", "Makefile", "scripts/verify", "scripts/docs-check"])),
    scope: full ? "full" : "focused",
    git: {
      sha: head,
      tree: startState.tree,
      base_ref: baseRef,
      base,
      main_head_at_start: baseHead,
      lockfile_sha256: startState.lockfile,
      tracked_and_untracked_clean_at_start: cleanAtStart,
      tracked_and_untracked_clean_at_end: endState ? endState.status === "" : null,
    },
    task_card: task,
    executor: {
      id: process.env.VERIFY_EXECUTOR_ID || "unnamed",
      os: process.platform,
      arch: process.arch === "x64" ? "amd64" : process.arch,
      docker: probe("docker", ["version", "--format", "{{.Server.Version}}"]),
      node: process.versions.node,
      pnpm: probe("pnpm", ["--version"]),
      postgres: db ? probe("psql", ["-XAtqc", "show server_version"], { ...process.env, ...pgEnv(db.url) }) : null,
    },
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    stages: results,
    pending_stages: PENDING_STAGES,
    exit_status: exitStatus,
    failed_stage: failedStage,
    secret_scan: receipt.secret_scan ?? null,
    audit: receipt.audit ?? null,
    log_digest: `sha256:${sha256(Buffer.concat(logs.map((f) => readFileSync(f))))}`,
  };
  // No receipt without both supply-chain sections (rules §8.3): it would read as a pass it is not.
  if (!quick && (!body.secret_scan || !body.audit) && body.exit_status === 0) {
    body.exit_status = 1;
    body.failed_stage = body.failed_stage ?? (!body.secret_scan ? "secrets" : "audit");
  }
  const dir = path.join(ROOT, ".verify", "receipts");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return path.relative(ROOT, file);
}

process.on("SIGINT", () => {
  stopAll();
  if (!quick) console.error(`interrupted; receipt ${writeReceipt(130, `${current || "start"} (interrupted)`, null)}`);
  process.exit(130);
});

console.log(
  `${quick ? "pnpm check" : "make verify"} on ${head.slice(0, 12)}${base ? ` (base ${base.slice(0, 12)} from ${baseRef})` : ""}${task ? `, ${task}` : ""}`,
);
for (const [i, stage] of selected.entries()) {
  current = stage.name;
  const log = openLog(path.join(logDir, `${String(results.length + 1).padStart(2, "0")}-${stage.name}.log`));
  const t0 = performance.now();
  let outcome: Outcome;
  const blocked = (stage.after ?? []).find((n) => results.some((r) => r.name === n && r.status !== "pass"));
  if (skip.includes(stage.name)) outcome = { status: "skipped", note: "skipped on request (VERIFY_SKIP / --skip)" };
  else if (blocked) outcome = { status: "skipped", note: `${blocked} did not pass` };
  else if (stage.needsDb && !db) outcome = { status: "skipped", note: "no database (set VERIFY_DATABASE_URL to a *_ci or *_test database)" };
  else {
    try {
      outcome = await stage.run({ log, head, base, task, db, quick, env: childEnv });
    } catch (e) {
      outcome = fail((e as Error).message);
    }
  }
  const duration = Math.round((performance.now() - t0) / 100) / 10;
  log.line(`== ${stage.name}: ${outcome.status}${outcome.note ? ` — ${outcome.note}` : ""}`);
  results.push({ name: stage.name, status: outcome.status, duration_s: duration, ...(outcome.note ? { note: outcome.note } : {}) });
  console.log(`[${i + 1}/${selected.length}] ${stage.name.padEnd(13)} ${outcome.status.padEnd(7)} ${String(duration).padStart(6)} s  ${outcome.note ?? ""}`);
  if (outcome.status === "fail") {
    const tail = readFileSync(log.file, "utf8").trimEnd().split("\n").slice(-25);
    for (const l of tail) console.log(`    | ${l}`);
  }
}
current = "";

const endState = treeState();
const drift: string[] = [];
if (endState.head !== startState.head) drift.push("HEAD moved");
if (endState.tree !== startState.tree) drift.push("the commit's tree changed");
if (endState.lockfile !== startState.lockfile) drift.push("pnpm-lock.yaml changed");
if (cleanAtStart && endState.status !== "") drift.push(`the checks left files behind:\n${endState.status.split("\n").slice(0, 10).join("\n")}`);
for (const d of drift) console.log(`drift: ${d}`);

const failedStage = drift.length ? "end-state" : (results.find((r) => r.status === "fail")?.name ?? null);
const exitStatus = failedStage ? 1 : 0;
if (quick) {
  console.log(exitStatus ? "pnpm check: failed" : "pnpm check: passed (fast subset; merging needs a make verify receipt)");
  process.exit(exitStatus);
}
const file = writeReceipt(exitStatus, failedStage, endState);
const scope = (JSON.parse(readFileSync(path.join(ROOT, file), "utf8")) as { scope: string; exit_status: number }).scope;
const finalStatus = (JSON.parse(readFileSync(path.join(ROOT, file), "utf8")) as { exit_status: number }).exit_status;
console.log(`receipt ${file}: ${finalStatus === 0 ? "passed" : "FAILED"}, scope ${scope}${scope === "focused" ? " (cannot be used to merge)" : ""}`);
process.exit(finalStatus === 0 ? 0 : 1);
