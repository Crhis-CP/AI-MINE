import { healthFailureEvidence } from "./local-health.ts";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { localRelease, type LocalRelease, validateLocalRelease } from "./local-release.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
/** Accept only the intended unhealthy-candidate recovery, never an arbitrary nonzero CLI result. */
export function expectedRecovery(code: number, value: unknown, input: LocalRelease) {
  if (!value || typeof value !== "object") return false;
  const journal = value as Record<string, unknown>;
  const result = journal.result as Record<string, unknown> | null;
  const failure = healthFailureEvidence(result?.failure);
  return (
    code === 1 &&
    journal.source === input.sha &&
    journal.previous === input.previous &&
    journal.candidate === input.candidate &&
    result?.status === "recovered" &&
    result.failedPhase === "candidate_health" &&
    result.cleaned === true &&
    failure?.reason === "http_status" &&
    failure.observation?.status === 503 &&
    failure.observation.direct === true &&
    Array.isArray(result.passed) &&
    result.passed.length === 2 &&
    result.passed[0] === "baseline" &&
    result.passed[1] === "rollback"
  );
}

/** A bounded evidence projection for the main verify receipt; no environment, paths or raw logs. */
export function rehearsalEvidence(
  code: number,
  input: Pick<LocalRelease, "sha" | "previous"> & { fixtureSha256: string },
  preparation: unknown,
  value: unknown,
) {
  const object = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const p = object(preparation),
    j = object(value),
    r = object(j.result);
  const candidate = typeof p.faultImage === "string" && /^sha256:[a-f0-9]{64}$/.test(p.faultImage) ? p.faultImage : null;
  const phase = /^(?:preflight|preparation_failed|cleanup(?:_failed)?|(?:baseline|candidate|rollback)_(?:(?:start|health|checks)(?:_failed)?|passed))$/;
  const phases = Array.isArray(j.events) && j.events.every((v) => typeof v === "string" && phase.test(v)) ? (j.events as string[]) : [];
  const passed = Array.isArray(r.passed) && r.passed.every((v) => ["baseline", "candidate", "rollback"].includes(v)) ? (r.passed as string[]) : [];
  const boundToInput =
    !!candidate &&
    p.source === input.sha &&
    p.normalImage === input.previous &&
    p.fixtureSha256 === input.fixtureSha256 &&
    j.source === input.sha &&
    j.previous === input.previous &&
    j.candidate === candidate;
  const expected =
    "preflight,baseline_start,baseline_health,baseline_checks,baseline_passed,candidate_start,candidate_health,candidate_health_failed,rollback_start,rollback_health,rollback_checks,rollback_passed,cleanup";
  return {
    testOnly: true,
    source: input.sha,
    normalImage: input.previous,
    faultImage: candidate,
    fixtureSha256: input.fixtureSha256,
    boundToInput,
    accepted:
      code === 0 &&
      boundToInput &&
      p.testOnly === true &&
      p.containersRemoved === true &&
      p.imagesRemoved === true &&
      expectedRecovery(p.controllerExit as number, j, { ...input, candidate: candidate ?? "", record: "unused" }) &&
      phases.join(",") === expected,
    preparation: {
      phase: ["preparing", "created", "copied", "committed", "rehearsal"].includes(p.phase as string) ? p.phase : null,
      containersRemoved: p.containersRemoved === true,
      imagesRemoved: p.imagesRemoved === true,
    },
    rehearsal: {
      controllerExit: p.controllerExit === 0 || p.controllerExit === 1 ? p.controllerExit : null,
      phases,
      passed,
      status: ["passed", "recovered", "failed"].includes(r.status as string) ? r.status : null,
      failedPhase: typeof r.failedPhase === "string" && phase.test(r.failedPhase) ? r.failedPhase : null,
      cleaned: r.cleaned === true,
      failure: healthFailureEvidence(r.failure),
    },
  };
}

export async function checkLocalRelease(input: Omit<LocalRelease, "candidate">, signal?: AbortSignal) {
  validateLocalRelease({ ...input, candidate: input.previous }, process.env);
  const record = path.resolve(input.record);
  if (existsSync(record)) throw new Error("Rehearsal evidence already exists");
  mkdirSync(path.dirname(record), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const container = `amp-local-fault-${token}`,
    image = `${container}:fixture`;
  const fixture = path.join(ROOT, "deploy/fixtures/unhealthy-api.ts");
  const preparation = {
    source: input.sha,
    normalImage: input.previous,
    fixtureSha256: createHash("sha256").update(readFileSync(fixture)).digest("hex"),
    container,
    token,
    testOnly: true,
    faultImage: "",
    phase: "preparing",
    controllerExit: null as number | null,
    accepted: false,
    containersRemoved: false,
    imagesRemoved: false,
  };
  const evidence = `${record}.images.json`;
  writeFileSync(evidence, `${JSON.stringify(preparation, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const config = mkdtempSync(path.join(tmpdir(), "amp-local-docker-"));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: config };
  const docker = async (args: string[], cleanup = false) => {
    if (!cleanup && signal?.aborted) throw new Error("Local rehearsal interrupted");
    const { stdout } = await promisify(execFile)("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
      cwd: ROOT,
      env,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  };
  const save = () => writeFileSync(evidence, `${JSON.stringify(preparation, null, 2)}\n`, { mode: 0o600 });
  const clean = async (kind: "container" | "image") => {
    try {
      const ids = [...new Set((await docker([kind, "ls", "-aq", "--filter", `label=amp.local-rehearsal=${token}`], true)).split(/\s+/).filter(Boolean))];
      if (ids.length) await docker([kind, "rm", ...ids], true);
      return !(await docker([kind, "ls", "-aq", "--filter", `label=amp.local-rehearsal=${token}`], true));
    } catch {
      return false;
    }
  };
  try {
    if ((await docker(["image", "inspect", input.previous, "--format", "{{.Id}}"])) !== input.previous) throw new Error("Normal image identity mismatch");
    await docker(["create", "--name", container, "--network", "none", "--label", `amp.local-rehearsal=${token}`, input.previous]);
    preparation.phase = "created";
    save();
    await docker(["cp", fixture, `${container}:/app/apps/api/src/main.ts`]);
    preparation.phase = "copied";
    save();
    await docker(["commit", container, image]);
    preparation.faultImage = await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
    preparation.phase = "committed";
    save();
    preparation.containersRemoved = await clean("container");
    save();
    if (!preparation.containersRemoved) throw new Error("Intermediate container cleanup failed");
    const request = { ...input, record, candidate: preparation.faultImage };
    preparation.phase = "rehearsal";
    save();
    preparation.controllerExit = await localRelease(request, signal);
    preparation.accepted = expectedRecovery(preparation.controllerExit, JSON.parse(readFileSync(record, "utf8")), request);
  } catch {
    preparation.accepted = false;
  } finally {
    preparation.containersRemoved = await clean("container");
    preparation.imagesRemoved = await clean("image");
    try {
      save();
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  }
  return preparation.accepted && preparation.containersRemoved && preparation.imagesRemoved ? 0 : 1;
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
    process.exitCode = await checkLocalRelease({ sha: value("--sha"), previous: value("--previous"), record: value("--record") }, controller.signal);
  } catch {
    console.error("Local fault-image preparation failed; no successful rehearsal was recorded");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort).off("SIGTERM", abort);
  }
}
