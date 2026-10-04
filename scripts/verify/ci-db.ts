// The database for a GitHub Actions run of make verify (TASK-0015). Its image is the one docker-compose.yml's
// `db` service runs, so the image is written in one place: a card that changes the database image (TASK-0006)
// edits compose and the workflow follows, without touching .github/. Started with `docker run` on
// 127.0.0.1:5432 with trust authentication and no password, then waited for with the runner's pg_isready over
// TCP: on its first start the image runs a temporary server on the socket only, so a TCP answer means the real
// server. make verify then names a *_ci database there (VERIFY_DATABASE_URL in the workflow).
//   node scripts/verify/ci-db.ts      prints the image, starts the container amp-ci-db, waits up to 120 s, then
//                                     prints the runner's psql version (make verify uses that client; README §7)
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parse } from "yaml";
import { ROOT } from "./lib.ts";
import { PINNED_IMAGE } from "./toolchain.ts";
import { installPgTools } from "./pg-tools.ts";

/** The image of the compose file's `db` service, which must name a patch version and its sha256 digest. */
export function composeDbImage(text: string): string {
  const doc = parse(text) as { services?: Record<string, { image?: unknown } | null> } | null;
  const image = doc?.services?.db?.image;
  if (typeof image !== "string" || !image) throw new Error("docker-compose.yml: service db has no image");
  if (!PINNED_IMAGE.test(image)) throw new Error(`docker-compose.yml: service db: image must name a patch version and its sha256 digest: ${image}`);
  return image;
}

if (import.meta.main) {
  const image = composeDbImage(readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8"));
  console.log(`database image (docker-compose.yml, service db): ${image}`);
  const args = ["run", "--detach", "--name", "amp-ci-db", "--publish", "127.0.0.1:5432:5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", image];
  const started = spawnSync("docker", args, { stdio: "inherit" });
  if (started.status !== 0) process.exit(started.status ?? 1);
  for (let second = 0; second < 120; second++) {
    if (spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "5432", "-U", "postgres"], { stdio: "ignore" }).status === 0) {
      const client = spawnSync("psql", ["--version"], { encoding: "utf8" }).stdout?.trim() || "not found";
      console.log(`database ready on 127.0.0.1:5432; the runner's psql client: ${client}`);
      const bin = installPgTools("amp-ci-db", 5432, image, path.join(ROOT, ".verify", "pg-tools", "bin"));
      if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
      console.log(`matching pg_dump/pg_restore for this test container: ${bin}`);
      process.exit(0);
    }
    await sleep(1000);
  }
  spawnSync("docker", ["logs", "amp-ci-db"], { stdio: "inherit" });
  console.error("the database did not accept connections within 120 s");
  process.exit(1);
}
