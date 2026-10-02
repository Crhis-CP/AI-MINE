// toolchain: a second lockfile, a loose package manager pin, the missing release delay, `pnpm deploy`, an
// unpinned base image and a workflow file are each stopped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkToolchain } from "../toolchain.ts";
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
    ".github/workflows/ci.yml: GitHub Actions stay off (ADR-0017); checks run through make verify — move the file out of .github/workflows",
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
