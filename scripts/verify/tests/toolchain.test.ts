// toolchain: a second lockfile, a loose package manager pin, the missing release delay, `pnpm deploy`, an
// unpinned base image and a second workflow file are each stopped; so is every way the verify workflow can
// leave its shape (TASK-0015: 13 rules, at least one case each).
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions (${{ … }}) are plain text in these fixtures
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkToolchain, WORKFLOW, workflowProblems } from "../toolchain.ts";
import { scratch, write } from "./helpers.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const good: Record<string, string> = {
  "package.json": JSON.stringify({ packageManager: "pnpm@12.8.1", engines: { node: ">=24.11" } }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - apps/*\nminimumReleaseAge: 1440\nallowBuilds: {}\n",
  Dockerfile: `# pnpm deploy is not used (comment)\nFROM node:24.21.0-trixie-slim@${DIGEST} AS base\nARG NPM_REGISTRY=\nFROM base\nRUN pnpm install --prod --frozen-lockfile\n`,
  "docker-compose.yml": `services:\n  app:\n    build: .\n    image: amp-app\n  db:\n    image: postgres:17.11-alpine@${DIGEST}\n`,
};

function problemsWith(changes: Record<string, string>): string[] {
  const dir = scratch();
  const files = { ...good, ...changes };
  write(dir, files);
  return checkToolchain(dir, Object.keys(files));
}

test("the expected setup passes", () => {
  assert.deepEqual(problemsWith({}), []);
});

test("each violation is reported", () => {
  const problems = problemsWith({
    "package.json": JSON.stringify({ packageManager: "pnpm@^12", engines: { node: ">=24.11" } }),
    "package-lock.json": "{}",
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    Dockerfile: "FROM node:24-slim\nRUN pnpm install --prod\nRUN pnpm deploy --filter web /out\n",
    "docker-compose.yml": "services:\n  db:\n    image: postgres:17-alpine\n",
    ".github/workflows/ci.yml": "on: push\n",
  });
  const expect = [
    'package.json: packageManager must pin an exact pnpm version (got "pnpm@^12")',
    "package-lock.json: only pnpm-lock.yaml is allowed (one lockfile, pnpm 12)",
    ".github/workflows/ci.yml: the only workflow is .github/workflows/verify.yml, which runs make verify (ADR-0017; TASK-0015); move this file out of .github/workflows",
    "pnpm-workspace.yaml: minimumReleaseAge must be at least 1440 minutes",
    "pnpm-workspace.yaml: allowBuilds must be an explicit mapping (empty when no dependency needs install scripts)",
    "Dockerfile: `pnpm deploy` is not allowed (copy the repository and run pnpm install --prod)",
    "Dockerfile: keep the NPM_REGISTRY build argument",
    "Dockerfile: pnpm install without --frozen-lockfile: RUN pnpm install --prod",
    "Dockerfile: base image must name a patch version and its sha256 digest: node:24-slim",
    "docker-compose.yml: service db: image must name a patch version and its sha256 digest: postgres:17-alpine",
  ];
  assert.deepEqual(problems.sort(), expect.sort());
});

// A compliant verify workflow, written here rather than read from the repository: the tests must not assert
// that a CI workflow exists (rules file 8.1). "${{" stays a plain string, never a template literal.
const SHA_CHECKOUT = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SHA_SETUP_NODE = "820762786026740c76f36085b0efc47a31fe5020";
const HEAD = "${{ github.event.pull_request.head.sha || github.sha }}";
const WORKFLOW_TEXT = [
  "name: make verify (GitHub Actions)",
  "on:",
  "  pull_request:",
  "    types: [opened, synchronize, reopened, edited]",
  "  push:",
  "    branches: [main]",
  "  workflow_dispatch:",
  "    inputs:",
  "      task:",
  "        required: false",
  "        type: string",
  "permissions:",
  "  contents: read",
  "concurrency:",
  "  group: verify-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}",
  "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
  "jobs:",
  "  make-verify:",
  "    if: github.event.repository.visibility == 'public'",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 45",
  "    env:",
  "      VERIFY_EXECUTOR_ID: github-actions",
  "    steps:",
  `      - uses: actions/checkout@${SHA_CHECKOUT}`,
  "        with:",
  `          ref: ${HEAD}`,
  "          fetch-depth: 0",
  "          persist-credentials: false",
  `      - uses: actions/setup-node@${SHA_SETUP_NODE}`,
  "        with:",
  "          node-version: 24",
  "      - run: node scripts/verify/ci-db.ts",
  "      - run: node scripts/verify/pr-task.ts",
  "      - name: make verify",
  "        env:",
  `          HEAD_SHA: ${HEAD}`,
  '        run: make verify SHA="$HEAD_SHA"',
  "",
].join("\n");

/** The workflow with one exact piece of text replaced; fails loudly if the piece is not there. */
function edit(from: string, to: string): string {
  assert.ok(WORKFLOW_TEXT.includes(from), `fixture has no ${JSON.stringify(from)}`);
  return WORKFLOW_TEXT.replace(from, to);
}
const job = (what: string) => `${WORKFLOW}: job make-verify: ${what}`;
const STEP_SLOTS = "      - run: node scripts/verify/ci-db.ts\n";

test("the verify workflow in its shape passes, and so does a repository without one", () => {
  assert.deepEqual(workflowProblems(WORKFLOW, WORKFLOW_TEXT), []);
  assert.deepEqual(problemsWith({ [WORKFLOW]: WORKFLOW_TEXT }), []);
  assert.deepEqual(problemsWith({}), []);
});

test("each of the 13 workflow rules stops its violations", () => {
  const postgres = `postgres:17.11-alpine@${DIGEST}`; // pinned, and still not allowed: the image lives in compose
  const cases: Array<[rule: number, what: string, text: string, problem: string]> = [
    [
      2,
      "pull_request_target",
      edit("on:\n", "on:\n  pull_request_target:\n"),
      `${WORKFLOW}: trigger pull_request_target is not allowed (only pull_request, push to main and workflow_dispatch)`,
    ],
    [
      2,
      "a schedule",
      edit("on:\n", "on:\n  schedule:\n    - cron: '0 3 * * *'\n"),
      `${WORKFLOW}: trigger schedule is not allowed (only pull_request, push to main and workflow_dispatch)`,
    ],
    [
      2,
      "pull_request type labeled",
      edit("edited]", "edited, labeled]"),
      `${WORKFLOW}: pull_request may only list types opened, synchronize, reopened and edited`,
    ],
    [
      2,
      "a push to another branch",
      edit("branches: [main]", "branches: [main, release]"),
      `${WORKFLOW}: push may trigger it only for main (on.push.branches: [main], nothing else)`,
    ],
    [
      3,
      "a run pushed to main may be cancelled",
      edit("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true"),
      `${WORKFLOW}: cancel-in-progress may cancel a run pushed to main; use \${{ github.event_name == 'pull_request' }}`,
    ],
    [
      3,
      "pushes to main share a group",
      edit("|| github.sha }}", "|| github.ref }}"),
      `${WORKFLOW}: the concurrency group must name github.sha, so a run pushed to main is never replaced`,
    ],
    [4, "write permission", edit("contents: read", "contents: write"), `${WORKFLOW}: permissions must be exactly { contents: read }`],
    [
      4,
      "the job sets its own permissions",
      edit("    timeout-minutes: 45\n", "    timeout-minutes: 45\n    permissions:\n      contents: read\n"),
      job("permissions are set once, for the whole workflow"),
    ],
    [
      5,
      "a GitHub action off the list",
      edit(STEP_SLOTS, `      - uses: actions/cache@${SHA_CHECKOUT}\n${STEP_SLOTS}`),
      job(`step 3: actions/cache@${SHA_CHECKOUT}: only actions/checkout and actions/setup-node, pinned to a full commit SHA`),
    ],
    [
      5,
      "a third-party action",
      edit(STEP_SLOTS, `      - uses: some-org/setup-tools@${SHA_CHECKOUT}\n${STEP_SLOTS}`),
      job(`step 3: some-org/setup-tools@${SHA_CHECKOUT}: only actions/checkout and actions/setup-node, pinned to a full commit SHA`),
    ],
    [
      5,
      "an action by tag",
      edit(`actions/setup-node@${SHA_SETUP_NODE}`, "actions/setup-node@v7"),
      job("step 2: actions/setup-node@v7: only actions/checkout and actions/setup-node, pinned to a full commit SHA"),
    ],
    [
      5,
      "a reusable workflow",
      edit("    timeout-minutes: 45\n", `    timeout-minutes: 45\n    uses: some-org/workflows/.github/workflows/ci.yml@${SHA_CHECKOUT}\n`),
      job("uses a reusable workflow; only steps of this file may run"),
    ],
    [6, "checkout keeps credentials", edit("          persist-credentials: false\n", ""), job("step 1: actions/checkout must set persist-credentials: false")],
    [
      7,
      "a secret",
      edit("      VERIFY_EXECUTOR_ID: github-actions\n", "      VERIFY_EXECUTOR_ID: github-actions\n      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n"),
      `${WORKFLOW}: reads secrets; the verify workflow has none`,
    ],
    [
      7,
      "the token passed on",
      edit("      VERIFY_EXECUTOR_ID: github-actions\n", "      VERIFY_EXECUTOR_ID: github-actions\n      GH_TOKEN: ${{ github.token }}\n"),
      `${WORKFLOW}: passes the GitHub token on; the verify workflow needs none`,
    ],
    [
      8,
      "${{ }} inside run",
      edit("      - run: node scripts/verify/pr-task.ts\n", "      - run: node scripts/verify/pr-task.ts ${{ github.event.pull_request.title }}\n"),
      job("step 4: ${{ … }} inside run; pass the value through env"),
    ],
    [
      9,
      "continue-on-error",
      edit('        run: make verify SHA="$HEAD_SHA"\n', '        run: make verify SHA="$HEAD_SHA"\n        continue-on-error: true\n'),
      job("step 5: continue-on-error is not allowed"),
    ],
    [
      9,
      "a deployment environment",
      edit("    timeout-minutes: 45\n", "    timeout-minutes: 45\n    environment: production\n"),
      job("a deployment environment is not allowed"),
    ],
    [10, "no time limit", edit("    timeout-minutes: 45\n", ""), job("needs timeout-minutes")],
    [
      10,
      "a self-hosted runner",
      edit("runs-on: ubuntu-24.04", "runs-on: [self-hosted, linux]"),
      job('runs-on must be a GitHub-hosted Ubuntu image with its version (e.g. ubuntu-24.04), not ["self-hosted","linux"]'),
    ],
    [
      10,
      "ubuntu-latest",
      edit("runs-on: ubuntu-24.04", "runs-on: ubuntu-latest"),
      job('runs-on must be a GitHub-hosted Ubuntu image with its version (e.g. ubuntu-24.04), not "ubuntu-latest"'),
    ],
    [
      11,
      "no public-repository condition",
      edit("    if: github.event.repository.visibility == 'public'\n", ""),
      job("needs the condition if: github.event.repository.visibility == 'public' (Actions is free for public repositories only)"),
    ],
    [
      12,
      "a service container",
      edit("    timeout-minutes: 45\n", `    timeout-minutes: 45\n    services:\n      postgres:\n        image: ${postgres}\n`),
      job("service containers are not allowed; scripts/verify/ci-db.ts starts the database from docker-compose.yml's image"),
    ],
    [
      12,
      "a job container",
      edit("    timeout-minutes: 45\n", `    timeout-minutes: 45\n    container: node:24.21.0-trixie-slim@${DIGEST}\n`),
      job("a job container is not allowed"),
    ],
    [
      12,
      "no step starts the database",
      edit(STEP_SLOTS, ""),
      `${WORKFLOW}: no step runs node scripts/verify/ci-db.ts (the database image comes from docker-compose.yml)`,
    ],
    [
      13,
      "no step runs make verify",
      edit('run: make verify SHA="$HEAD_SHA"', "run: make check"),
      `${WORKFLOW}: no step runs make verify (the workflow is an executor of make verify and nothing else)`,
    ],
  ];
  for (const [rule, what, text, problem] of cases) {
    assert.deepEqual(workflowProblems(WORKFLOW, text), [problem], `rule ${rule}: ${what}`);
  }
  // Rule 1, through the stage itself: any other file under .github/workflows.
  assert.deepEqual(problemsWith({ [WORKFLOW]: WORKFLOW_TEXT, ".github/workflows/nightly.yml": "on: push\n" }), [
    ".github/workflows/nightly.yml: the only workflow is .github/workflows/verify.yml, which runs make verify (ADR-0017; TASK-0015); move this file out of .github/workflows",
  ]);
  assert.equal(cases.length + 1, 27);
  assert.deepEqual(
    [...new Set(cases.map(([rule]) => rule)), 1].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );
});
