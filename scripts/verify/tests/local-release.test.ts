import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { apiProcess } from "../../../tests/api-process.ts";
import { checkLocalRelease, expectedRecovery, rehearsalEvidence } from "../../../deploy/check-local-release.ts";
import { localRelease, rehearse, validateLocalRelease } from "../../../deploy/local-release.ts";

const previous = `sha256:${"a".repeat(64)}`;
const candidate = `sha256:${"b".repeat(64)}`;
const input = { sha: "c".repeat(40), previous, candidate, record: "unused.json" };

test("only exact local identities are accepted before any side effect", () => {
  validateLocalRelease(input, {});
  for (const patch of [{ sha: "main" }, { previous: "amp-app:latest" }, { candidate: `repo@${candidate}` }, { record: "" }])
    assert.throws(() => validateLocalRelease({ ...input, ...patch }, {}));
  for (const env of [{ DOCKER_HOST: "ssh://localhost" }, { DOCKER_HOST: "tcp://127.0.0.1:2375" }, { DOCKER_CONTEXT: "remote" }])
    assert.throws(() => validateLocalRelease(input, env), /local Docker/);
});

for (const [failures, status, passed] of [
  [[], "passed", ["baseline", "candidate"]],
  [["baseline_health"], "failed", []],
  [["candidate_start"], "recovered", ["baseline", "rollback"]],
  [["candidate_health"], "recovered", ["baseline", "rollback"]],
  [["candidate_checks"], "recovered", ["baseline", "rollback"]],
  [["candidate_health", "rollback_checks"], "failed", ["baseline"]],
  [["candidate_health", "cleanup"], "failed", ["baseline", "rollback"]],
] as const) {
  test(`rehearsal settles ${failures.join(" + ") || "a healthy candidate"} without losing cleanup`, async () => {
    let phase = "";
    const calls: [string, string][] = [];
    const action = async (image: string) => {
      calls.push([phase, image]);
      if ((failures as readonly string[]).includes(phase)) throw new Error("fixture failure");
    };
    const result = await rehearse(
      {
        start: action,
        health: action,
        checks: action,
        cleanup: () => action(""),
        event: (value) => {
          phase = value;
        },
      },
      previous,
      candidate,
    );
    assert.equal(result.status, status);
    assert.deepEqual(result.passed, passed);
    assert.equal(result.failedPhase, failures[0] ?? "");
    assert.equal(result.cleaned, !(failures as readonly string[]).includes("cleanup"));
    assert.equal(calls.at(-1)?.[0], "cleanup");
    for (const [step, image] of calls.filter(([step]) => step !== "cleanup")) assert.equal(image, step.startsWith("candidate_") ? candidate : previous);
    for (const name of passed)
      assert.deepEqual(
        calls.filter(([step]) => step.startsWith(`${name}_`)).map(([step]) => step),
        [`${name}_start`, `${name}_health`, `${name}_checks`],
      );
  });
}

test("an existing record or lock is preserved without contacting Docker", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "local-release-record-"));
  const record = path.join(dir, "evidence.json");
  const saved = { DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  delete process.env.DOCKER_HOST;
  delete process.env.DOCKER_CONTEXT;
  try {
    writeFileSync(record, "existing evidence");
    await assert.rejects(localRelease({ ...input, record }), /Evidence already exists/);
    assert.equal(readFileSync(record, "utf8"), "existing evidence");
    assert.deepEqual(readdirSync(dir), ["evidence.json"]);
    writeFileSync(`${record}.lock`, "other owner");
    await assert.rejects(localRelease({ ...input, record }), /EEXIST/);
    assert.equal(readFileSync(`${record}.lock`, "utf8"), "other owner");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CI accepts only matching health-failure recovery with both checks and cleanup", () => {
  const result = {
    status: "recovered",
    failedPhase: "candidate_health",
    cleaned: true,
    passed: ["baseline", "rollback"],
    failure: { reason: "http_status", observation: { target: "http://127.0.0.1:1234/api/health", status: 503, direct: true } },
  };
  const journal = { source: input.sha, previous, candidate, result };
  assert.equal(expectedRecovery(1, journal, input), true);
  for (const code of [0, 2, 130]) assert.equal(expectedRecovery(code, journal, input), false);
  for (const value of [null, {}, { ...journal, source: "different" }, { ...journal, candidate: previous }])
    assert.equal(expectedRecovery(1, value, input), false);
  for (const change of [
    { status: "failed" },
    { failedPhase: "candidate_start" },
    { failedPhase: "candidate_checks" },
    { cleaned: false },
    { failure: { reason: "endpoint_lookup", observation: null } },
    { failure: { reason: "connection", observation: null } },
    { failure: { reason: "http_status", observation: { target: "http://127.0.0.1:1234/api/health", status: 503, direct: false } } },
    { passed: ["baseline"] },
  ])
    assert.equal(expectedRecovery(1, { ...journal, result: { ...result, ...change } }, input), false);
});

for (const failure of ["create", "cp", "commit"]) {
  test(`fault-image ${failure} failure cleans registered resources even after an ambiguous creation`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "local-image-failure-")),
      bin = path.join(dir, "bin"),
      state = path.join(dir, "state.json");
    mkdirSync(bin);
    writeFileSync(state, JSON.stringify({ container: false, image: false, commands: [], config: "" }));
    writeFileSync(
      path.join(bin, "docker"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const file = ${JSON.stringify(state)}, failure = ${JSON.stringify(failure)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args.shift() !== '--host' || args.shift() !== 'unix:///var/run/docker.sock') process.exit(8);
state.commands.push(args); state.config = process.env.DOCKER_CONFIG;
let output = '', code = 0;
if (args[0] === 'create') state.container = true;
else if (args[0] === 'commit') state.image = true;
else if (args[0] === 'image' && args[1] === 'inspect') output = ${JSON.stringify(previous)};
else if (args[1] === 'ls') output = state[args[0]] ? (args[0] === 'container' ? 'owned-container' : ${JSON.stringify(candidate)}) : '';
else if (args[1] === 'rm') state[args[0]] = false;
else if (args[0] !== 'cp') code = 9;
if (args[0] === failure) code = 1;
fs.writeFileSync(file, JSON.stringify(state));
console.log(output); process.exit(code);
`,
      { mode: 0o755 },
    );
    const saved = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
    delete process.env.DOCKER_HOST;
    delete process.env.DOCKER_CONTEXT;
    try {
      const record = path.join(dir, "rehearsal.json");
      assert.equal(await checkLocalRelease({ ...input, record }), 1);
      const after = JSON.parse(readFileSync(state, "utf8"));
      const evidence = JSON.parse(readFileSync(`${record}.images.json`, "utf8"));
      assert.equal(after.container, false);
      assert.equal(after.image, false);
      assert.equal(existsSync(after.config), false);
      assert.equal(evidence.normalImage, previous);
      assert.match(evidence.fixtureSha256, /^[a-f0-9]{64}$/);
      assert.equal(evidence.accepted, false);
      assert.equal(evidence.controllerExit, null);
      assert.equal(evidence.containersRemoved && evidence.imagesRemoved, true);
      assert.equal(existsSync(record), false);
      assert.equal(
        after.commands.some(([command]: string[]) => ["build", "pull", "run", "start"].includes(command!)),
        false,
      );
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the copied fault entry stays alive and returns real HTTP 503", async (t) => {
  const child = await apiProcess(t, {}, ["deploy/fixtures/unhealthy-api.ts"]);
  let response: Response | undefined;
  for (let i = 0; i < 50 && !response; i++) {
    try {
      response = await fetch(`${child.url}/api/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      await delay(20);
    }
  }
  assert.equal(response?.status, 503, child.output());
  assert.deepEqual(await response!.json(), { ok: false });
  assert.equal((await fetch(`${child.url}/api/site/meta`)).status, 503);
});

test("the main receipt binds current inputs and projects no raw logs or environment", () => {
  const fixtureSha256 = "d".repeat(64);
  const preparation = {
    source: input.sha,
    normalImage: previous,
    faultImage: candidate,
    fixtureSha256,
    testOnly: true,
    phase: "rehearsal",
    controllerExit: 1,
    containersRemoved: true,
    imagesRemoved: true,
    environment: { SECRET: "do-not-project" },
  };
  const journal = {
    source: input.sha,
    previous,
    candidate,
    work: "do-not-project",
    events:
      "preflight,baseline_start,baseline_health,baseline_checks,baseline_passed,candidate_start,candidate_health,candidate_health_failed,rollback_start,rollback_health,rollback_checks,rollback_passed,cleanup".split(
        ",",
      ),
    result: {
      status: "recovered",
      failedPhase: "candidate_health",
      cleaned: true,
      passed: ["baseline", "rollback"],
      failure: { reason: "http_status", observation: { target: "http://127.0.0.1:1234/api/health", status: 503, direct: true, raw: "do-not-project" } },
    },
  };
  const expected = { sha: input.sha, previous, fixtureSha256 };
  const evidence = rehearsalEvidence(0, expected, preparation, journal);
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.boundToInput, true);
  assert.equal(JSON.stringify(evidence).includes("do-not-project"), false);
  for (const change of [{ source: "other" }, { fixtureSha256: "other" }, { imagesRemoved: false }])
    assert.equal(rehearsalEvidence(0, expected, { ...preparation, ...change }, journal).accepted, false);
  assert.equal(rehearsalEvidence(0, expected, preparation, { ...journal, events: [] }).accepted, false);
  assert.equal(rehearsalEvidence(1, expected, preparation, journal).accepted, false);
});
