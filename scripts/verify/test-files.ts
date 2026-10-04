import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabaseAccess } from "@amp/config";
import { ROOT } from "./lib.ts";

export function testFiles(root: string, requested: string[]) {
  const files = requested.length
    ? requested
    : readdirSync(path.join(root, "tests"))
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => `tests/${name}`);
  if (!files.length || new Set(files).size !== files.length) throw new Error("Test files must be nonempty and unique");
  for (const file of files)
    if (!/^tests\/(?:[\w-]+\/)*[\w-]+\.test\.ts$/.test(file) || realpathSync(path.join(root, file)) !== path.join(realpathSync(root), file))
      throw new Error(`Invalid test file: ${file}`);
  return files.sort();
}

/** Each real test file gets a process and a clone of a sealed, queue-free migration/topics template. */
export async function runTestFiles(requested: string[], options: { env?: NodeJS.ProcessEnv; root?: string; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const env = options.env ?? process.env,
    root = options.root ?? ROOT,
    files = testFiles(root, requested);
  const url = new URL(env.DATABASE_URL ?? "postgres://unset/unset");
  if (!/^\/[a-zA-Z0-9_]+_(test|ci)$/.test(url.pathname)) throw new Error("Test runner requires an isolated *_test or *_ci DATABASE_URL");
  const concurrency = Number(env.TEST_FILE_CONCURRENCY ?? 2);
  if (![1, 2].includes(concurrency)) throw new Error("TEST_FILE_CONCURRENCY must be 1 or 2");
  const access = createDatabaseAccess("test", { DATABASE_URL: url.toString(), DATABASE_POOL_MAX: "1" }, () => {}),
    control = access.dbFor("worker");
  const prefix = `tf_${randomBytes(5).toString("hex")}`,
    template = `${prefix}_template_test`;
  const dir = mkdtempSync(path.join(tmpdir(), "amp-test-files-")),
    databases = new Set<string>(),
    journals: { prefix: string; file: string }[] = [];
  const active = new Set<() => void>();
  const childEnv = (name: string) => {
    const address = new URL(url);
    address.pathname = `/${name}`;
    return { ...env, DATABASE_URL: address.toString(), DATABASE_POOL_MAX: "4", AMP_CREDENTIALS_DIR: "/nonexistent-test-credentials" };
  };
  const abort = () => {
    for (const stop of active) stop();
  };
  options.signal?.addEventListener("abort", abort);
  const run = (args: string[], environment: NodeJS.ProcessEnv, log: string, timeoutMs = 150_000) =>
    new Promise<number>((resolve) => {
      writeFileSync(log, "");
      if (options.signal?.aborted) return resolve(130);
      const fd = openSync(log, "w");
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, args, { cwd: root, env: environment, stdio: ["ignore", fd, fd], detached: true });
      } finally {
        closeSync(fd);
      }
      let interrupted = false,
        force: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch {
            /* Already stopped. */
          }
        }
      };
      const stop = () => {
        if (interrupted) return;
        interrupted = true;
        kill("SIGTERM");
        force = setTimeout(() => kill("SIGKILL"), 5_000);
      };
      active.add(stop);
      const timer = setTimeout(stop, timeoutMs);
      child.once("error", () => {
        interrupted = true;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(force);
        kill("SIGKILL"); // No detached descendants may survive a failed test's parent.
        active.delete(stop);
        resolve(interrupted ? 124 : (code ?? 1));
      });
    });
  const create = async (name: string, from: string) => {
    if ((await control`SELECT count(*)::int AS n FROM pg_database WHERE datname=${name}`)[0].n) throw new Error("Test database collision");
    databases.add(name);
    await control`CREATE DATABASE ${control(name)} TEMPLATE ${control(from)}`;
  };
  const show = (file: string, log: string) => {
    console.log(`ℹ file ${file}`);
    process.stdout.write(readFileSync(log));
  };
  const errors: unknown[] = [];
  let exitCode = 1;
  try {
    await create(template, "template0");
    for (const args of [["scripts/migrate.ts"], ["scripts/seed.ts", "--topics-only"]]) {
      const log = path.join(dir, "prepare.log");
      if (await run(args, childEnv(template), log)) {
        show(args[0]!, log);
        throw new Error("Test template preparation failed");
      }
    }
    const templateAccess = createDatabaseAccess("test", { ...childEnv(template), DATABASE_POOL_MAX: "1" }, () => {});
    try {
      const sql = templateAccess.dbFor("worker");
      const [state] = await sql`SELECT (SELECT count(*) FROM sources) AS sources, (SELECT count(*) FROM receipts) AS receipts,
        (SELECT count(*) FROM pg_namespace WHERE nspname='pgboss') AS queues`;
      if (state.sources || state.receipts || state.queues) throw new Error("Unsafe test template contents");
    } finally {
      await templateAccess.close();
    }
    await control`ALTER DATABASE ${control(template)} ALLOW_CONNECTIONS false`;
    for (let i = 0; (await control`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=${template}`)[0].n; i++) {
      if (i === 100) throw new Error("Template has active connections");
      await delay(50);
    }
    let next = 0,
      failed = false;
    const completed: { file: string; log: string; code: number }[] = [];
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, async () => {
        while (next < files.length && !options.signal?.aborted) {
          const index = next++,
            file = files[index]!,
            childPrefix = `${prefix}_${index.toString(36)}`,
            database = `${childPrefix}_test`;
          const work = path.join(dir, String(index)),
            journal = path.join(work, "resources.jsonl"),
            log = path.join(work, "test.log");
          mkdirSync(work);
          writeFileSync(journal, "");
          journals.push({ prefix: childPrefix, file: journal });
          await create(database, template);
          console.log(`# starting ${file}`);
          const code = await run(
            ["--test", "--test-reporter=spec", "--test-timeout=120000", file],
            {
              ...childEnv(database),
              TMPDIR: work,
              TMP: work,
              TEMP: work,
              AMP_DATA_DIR: path.join(work, "data"),
              AMP_TEST_RESOURCE_PREFIX: childPrefix,
              AMP_TEST_RESOURCE_JOURNAL: journal,
            },
            log,
            options.timeoutMs,
          );
          completed[index] = { file, log, code };
          await control`DROP DATABASE ${control(database)} WITH (FORCE)`;
          databases.delete(database);
          if (code) {
            failed = true;
          }
        }
      }),
    );
    for (const result of completed.filter(Boolean)) {
      show(result.file, result.log);
      if (result.code) console.error(`Test file failed: ${result.file} (exit ${result.code})`);
    }
    for (const result of results) if (result.status === "rejected") throw result.reason;
    exitCode = options.signal?.aborted ? 130 : failed ? 1 : 0;
  } catch (error) {
    errors.push(error);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    const roles = new Set<string>();
    try {
      for (const journal of journals)
        for (const line of readFileSync(journal.file, "utf8").split("\n").filter(Boolean)) {
          const record = JSON.parse(line) as { kind: string; name: string };
          if (!record.name.startsWith(`${journal.prefix}_`) || !/^[a-z][a-z0-9_]{0,62}$/.test(record.name) || !["role", "database"].includes(record.kind)) {
            errors.push(new Error("Invalid test resource journal"));
            continue;
          }
          (record.kind === "role" ? roles : databases).add(record.name);
        }
    } catch (error) {
      errors.push(error);
    }
    for (const name of databases) {
      try {
        await control`DROP DATABASE IF EXISTS ${control(name)} WITH (FORCE)`;
      } catch (error) {
        errors.push(error);
      }
    }
    for (const name of roles) {
      try {
        await control`DROP ROLE IF EXISTS ${control(name)}`;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await access.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, `Test execution or cleanup failed; resource journal retained at ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  return exitCode;
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop).on("SIGINT", stop);
  try {
    process.exitCode = await runTestFiles(process.argv.slice(2), { signal: controller.signal });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.off("SIGTERM", stop).off("SIGINT", stop);
  }
}
