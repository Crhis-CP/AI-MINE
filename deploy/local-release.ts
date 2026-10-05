import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HealthFailure, LocalHealthFailure, readLocalHealth } from "./local-health.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOCKET = "unix:///var/run/docker.sock";
export type LocalRelease = { sha: string; previous: string; candidate: string; record: string };
export function validateLocalRelease(input: LocalRelease, env: NodeJS.ProcessEnv) {
  if (!/^[a-f0-9]{40}$/.test(input.sha)) throw new Error("An exact source commit is required");
  for (const image of [input.previous, input.candidate])
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Only local immutable image IDs are accepted");
  if ((env.DOCKER_HOST && env.DOCKER_HOST !== SOCKET) || (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== "default"))
    throw new Error("Only the local Docker socket is allowed");
  if (!input.record) throw new Error("A new evidence path is required");
}

type Driver = {
  start(image: string): Promise<void>;
  health(image: string): Promise<void>;
  checks(image: string): Promise<void>;
  cleanup(): Promise<void>;
  event(phase: string): void;
};
/** The candidate's failure remains a failure even when the previous image passes all checks again. */
export async function rehearse(driver: Driver, previous: string, candidate: string) {
  let phase = "baseline_start";
  const result = { status: "failed", failedPhase: "", failure: null as HealthFailure | null, cleaned: false, passed: [] as string[] };
  const verify = async (name: string, image: string) => {
    for (const step of ["start", "health", "checks"] as const) {
      phase = `${name}_${step}`;
      driver.event(phase);
      await driver[step](image);
    }
    result.passed.push(name);
    driver.event(`${name}_passed`);
  };
  try {
    await verify("baseline", previous);
    await verify("candidate", candidate);
    result.status = "passed";
  } catch (error) {
    result.failedPhase = phase;
    result.failure = error instanceof LocalHealthFailure ? error.failure : { reason: "operation_failed", observation: null };
    driver.event(`${phase}_failed`);
    if (phase.startsWith("candidate_")) {
      try {
        await verify("rollback", previous);
        result.status = "recovered";
      } catch {
        driver.event(`${phase}_failed`);
      }
    }
  } finally {
    driver.event("cleanup");
    try {
      await driver.cleanup();
      result.cleaned = true;
    } catch {
      result.status = "failed";
      driver.event("cleanup_failed");
    }
  }
  return result;
}

export async function localRelease(input: LocalRelease, signal?: AbortSignal) {
  validateLocalRelease(input, process.env);
  const record = path.resolve(input.record);
  mkdirSync(path.dirname(record), { recursive: true });
  const lock = openSync(`${record}.lock`, "wx", 0o600);
  let work = "",
    retainWork = false;
  let dispose: (() => Promise<void>) | undefined;
  try {
    if (existsSync(record)) throw new Error("Evidence already exists; choose a new path");
    work = mkdtempSync(path.join(tmpdir(), "amp-local-release-"));
    const project = `amp-local-${randomBytes(8).toString("hex")}`;
    const journal = {
      source: input.sha,
      previous: input.previous,
      candidate: input.candidate,
      project,
      work,
      events: [] as string[],
      result: null as Awaited<ReturnType<typeof rehearse>> | null,
    };
    const persist = () => {
      writeFileSync(`${record}.tmp`, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(`${record}.tmp`, record);
    };
    const event = (phase: string) => {
      journal.events.push(phase);
      persist();
    };
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: path.join(work, "docker-config") };
    mkdirSync(env.DOCKER_CONFIG!);
    const command = (cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}, cwd = work, cleanup = false) =>
      new Promise<string>((resolve, reject) => {
        if (!cleanup && signal?.aborted) return reject(new Error("Local rehearsal interrupted"));
        const child = spawn(cmd, args, { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "ignore"], detached: true });
        let output = "",
          failed = false;
        const stop = () => {
          failed = true;
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }
        };
        const timer = setTimeout(stop, cleanup ? 240_000 : 300_000);
        if (!cleanup) signal?.addEventListener("abort", stop, { once: true });
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.length > 4_000_000) stop();
        });
        child.once("error", () => {
          failed = true;
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          if (failed || code !== 0) reject(new Error(`${path.basename(cmd)} failed during local rehearsal`));
          else resolve(output.trim());
        });
      });
    const docker = (args: string[], extra: NodeJS.ProcessEnv = {}, cleanup = false) => command("docker", ["--host", SOCKET, ...args], extra, work, cleanup);
    const compose = (image: string, args: string[], cleanup = false) =>
      docker(
        ["compose", "--env-file", path.join(work, ".env"), "-f", path.join(work, "docker-compose.yml"), "-p", project, ...args],
        { APP_IMAGE: image, PORT: "0", AMP_RELEASE: input.sha },
        cleanup,
      );
    let started = false;
    const occupied = async (cleanup = false) =>
      (
        await Promise.all(
          ["container", "volume", "network"].map((kind) =>
            docker([kind, "ls", ...(kind === "container" ? ["--all"] : []), "-q", "--filter", `label=com.docker.compose.project=${project}`], {}, cleanup),
          ),
        )
      ).some(Boolean);
    dispose = async () => {
      try {
        if (started) {
          await compose(input.previous, ["down", "--volumes", "--remove-orphans"], true);
          if (await occupied(true)) throw new Error("Owned local resources remain");
        }
        rmSync(work, { recursive: true, force: true });
        work = "";
      } catch (error) {
        retainWork = true;
        throw error;
      }
    };
    event("preflight");
    try {
      for (const image of [input.previous, input.candidate])
        if ((await docker(["image", "inspect", image, "--format", "{{.Id}}"])) !== image) throw new Error("Local image identity mismatch");
      if (await occupied()) throw new Error("Local project collision");
      const tar = path.join(work, "source.tar");
      await command("git", ["--no-replace-objects", "archive", "--format=tar", "-o", tar, input.sha], {}, ROOT);
      await command("tar", ["-xf", tar, "-C", work]);
      rmSync(tar);
      await command(process.execPath, ["scripts/init-env.ts", "--llm-key", "local-not-a-real-key"]);
      const dotenv = path.join(work, ".env");
      const config = readFileSync(dotenv, "utf8")
        .replace(/^COLLECT_ENABLED=.*$/m, "COLLECT_ENABLED=false")
        .replace(/^MODEL_CALLS_ENABLED=.*$/m, "MODEL_CALLS_ENABLED=false");
      writeFileSync(
        dotenv,
        `${config}\nCOLLECT_ENABLED=false\nMODEL_CALLS_ENABLED=false\nFEISHU_CONTENT_PUSH_ENABLED=false\nINDEXNOW_SUBMIT_ENABLED=false\nMCP_ALLOWED_HOSTS=web\nPRIVATE_HOST=private.localhost\nAMP_RELEASE=${input.sha}\n`,
        { mode: 0o600 },
      );
      journal.result = await rehearse(
        {
          event,
          async start(image) {
            started = true;
            await compose(image, ["up", "-d", "--no-build", "--pull", "never"]);
          },
          async health(image) {
            await readLocalHealth(() => compose(image, ["port", "web", "3000"]), input.sha, { signal });
          },
          async checks(image) {
            const ids = (await compose(image, ["ps", "--status", "running", "-q", "public-api", "private-api", "worker", "web"])).split(/\s+/);
            if (ids.length !== 4) throw new Error("Not all application roles are running");
            const images = (await docker(["inspect", "--format", "{{.Config.Image}}", ...ids])).split(/\s+/);
            if (images.length !== 4 || images.some((actual) => actual !== image)) throw new Error("Running image identity mismatch");
            await compose(image, ["exec", "-T", "public-api", "node", "scripts/smoke.ts", "--base", "http://web:3000"]);
            await compose(image, [
              "exec",
              "-T",
              "public-api",
              "node",
              "scripts/verify/api-split.ts",
              "http://web:3000",
              "http://public-api:3001",
              "http://private-api:3002",
            ]);
          },
          cleanup: dispose,
        },
        input.previous,
        input.candidate,
      );
      persist();
      return journal.result.status === "passed" ? 0 : 1;
    } catch {
      event("preparation_failed");
      throw new Error(`Local rehearsal preparation failed; evidence: ${record}`);
    }
  } finally {
    try {
      if (work && !retainWork) {
        if (dispose) await dispose();
        else rmSync(work, { recursive: true, force: true });
      }
    } finally {
      closeSync(lock);
      rmSync(`${record}.lock`, { force: true });
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 || args[index + 1]?.startsWith("--") ? "" : (args[index + 1] ?? "");
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort).on("SIGTERM", abort);
  try {
    process.exitCode = await localRelease(
      { sha: value("--sha"), previous: value("--previous"), candidate: value("--candidate"), record: value("--record") },
      controller.signal,
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort).off("SIGTERM", abort);
  }
}
