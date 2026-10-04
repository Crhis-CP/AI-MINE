// Test-only pg_dump/pg_restore adapters: reuse the exact database container, stream host files via fds.
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_IMAGE } from "./toolchain.ts";

export interface PgToolTarget {
  id: string;
  image: string;
  hostPort: number;
}
const common = ["--no-owner", "-O", "--no-acl", "--no-privileges", "-x", "--verbose", "-v"];
const flags = {
  pg_dump: new Set([...common, "--schema-only", "-s", "--data-only", "-a"]),
  pg_restore: new Set([...common, "--list", "-l", "--exit-on-error", "-e"]),
};
const values = new Set(["--format", "-F", "--compress", "-Z", "--schema", "-n", "--table", "-t"]);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function validateTarget(target: PgToolTarget) {
  if (
    !/^[a-f0-9]{64}$/.test(target.id) ||
    !PINNED_IMAGE.test(target.image) ||
    !Number.isInteger(target.hostPort) ||
    target.hostPort < 1 ||
    target.hostPort > 65535
  )
    throw new Error("Invalid explicit test PostgreSQL container binding");
}

/** Only the published test port changes. Credentials, database name and supported URL options stay intact. */
export function testDatabaseUrl(value: string, hostPort: number): string {
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      Number(url.port || "5432") !== hostPort ||
      !/_(test|ci)$/.test(decodeURIComponent(url.pathname.slice(1))) ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => !["sslmode", "target_session_attrs", "application_name"].includes(key))
    )
      throw new Error();
    url.port = "5432";
    return url.toString();
  } catch {
    throw new Error("pg tools require a loopback *_test or *_ci URL at the bound test port");
  }
}

/** Deliberately supports the verification/backup invocations, not arbitrary Docker commands or libpq targets. */
export function pgToolPlan(tool: string, args: readonly string[], target: PgToolTarget) {
  validateTarget(target);
  if (tool !== "pg_dump" && tool !== "pg_restore") throw new Error("Only pg_dump and pg_restore are supported");
  const command: string[] = [],
    positional: string[] = [];
  let database: string | undefined, output: string | undefined;
  if (args.length === 1 && args[0] === "--version") return { tool, command: ["--version"], input: undefined, output };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    const equal = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const key = equal < 0 ? arg : arg.slice(0, equal);
    if (["--dbname", "-d", "--file", "-f"].includes(key) || (tool === "pg_dump" && values.has(key))) {
      const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
      if (!value) throw new Error("Missing pg tool option value");
      if (key === "--dbname" || key === "-d") {
        if (database !== undefined) throw new Error("Duplicate database argument");
        database = value;
      } else if (key === "--file" || key === "-f") {
        if (tool !== "pg_dump" || output !== undefined) throw new Error("Only one pg_dump host output file is supported");
        output = value;
      } else command.push(key, value);
    } else if (equal < 0 && flags[tool].has(arg)) command.push(arg);
    else if (arg === "-" || !arg.startsWith("-")) positional.push(arg);
    else throw new Error("Unsupported pg tool argument");
  }
  if (positional.length > 1 || (tool === "pg_dump" && database && positional.length)) throw new Error("Unexpected pg tool positional arguments");
  if (tool === "pg_dump") database ??= positional[0];
  if (database) command.push("--dbname", testDatabaseUrl(database, target.hostPort));
  else if (tool === "pg_dump" || !command.some((arg) => arg === "--list" || arg === "-l")) throw new Error("A test database URL is required");
  return { tool, command, input: tool === "pg_restore" ? positional[0] : undefined, output: output === "-" ? undefined : output };
}

export function runPgTool(tool: string, args: readonly string[], target: PgToolTarget) {
  const plan = pgToolPlan(tool, args, target);
  const fds: number[] = [];
  const open = (file: string, mode: "r" | "w") => {
    const fd = openSync(file, mode, 0o600);
    fds.push(fd);
    return fd;
  };
  try {
    const input = plan.input && plan.input !== "-" ? open(plan.input, "r") : 0;
    const output = plan.output ? open(plan.output, "w") : 1;
    const result = spawnSync("docker", ["exec", "--interactive", target.id, plan.tool, ...plan.command], { stdio: [input, output, 2] });
    if (result.error) throw new Error("Could not execute the matching PostgreSQL tool");
    return { code: result.status ?? 1, signal: result.signal };
  } finally {
    for (const fd of fds) closeSync(fd);
  }
}

/** Bind launchers to an already running, pinned container with this exact loopback publication. No credentials are stored. */
export function installPgTools(container: string, hostPort: number, image: string, directory: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container) || !PINNED_IMAGE.test(image)) throw new Error("An explicit pinned test container is required");
  const format = '{"id":{{json .Id}},"image":{{json .Config.Image}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}}}';
  const inspected = spawnSync("docker", ["inspect", "--type", "container", "--format", format, container], { encoding: "utf8" });
  if (inspected.status !== 0) throw new Error("Could not inspect the explicit test PostgreSQL container");
  const info = JSON.parse(inspected.stdout);
  const target: PgToolTarget = { id: info?.id, image, hostPort };
  validateTarget(target);
  if (
    info.image !== image ||
    info.running !== true ||
    !info.ports?.["5432/tcp"]?.some((p: { HostIp: string; HostPort: string }) => p.HostIp === "127.0.0.1" && p.HostPort === String(hostPort))
  )
    throw new Error("Test container image, running state or loopback port does not match");
  const bin = path.resolve(directory);
  mkdirSync(bin, { recursive: true });
  const config = path.join(bin, "target.json");
  writeFileSync(config, JSON.stringify(target), { mode: 0o600 });
  for (const tool of ["pg_dump", "pg_restore"])
    writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} run ${shellQuote(config)} ${tool} "$@"\n`,
      { mode: 0o700 },
    );
  return bin;
}

if (import.meta.main) {
  try {
    const [mode, first, second, third, fourth, ...rest] = process.argv.slice(2);
    if (mode === "install" && first && second && third && fourth && !rest.length) console.log(installPgTools(first, Number(second), third, fourth));
    else if (mode === "run" && first && second) {
      const result = runPgTool(second, process.argv.slice(5), JSON.parse(readFileSync(first, "utf8")));
      if (result.signal) process.kill(process.pid, result.signal);
      else process.exitCode = result.code;
    } else throw new Error("Usage: pg-tools.ts install <test-container> <host-port> <pinned-image> <private-bin>");
  } catch {
    console.error("pg tools adapter rejected its binding, arguments or host file; no connection details are logged");
    process.exitCode = 2;
  }
}
