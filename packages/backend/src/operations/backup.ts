// Database and file backups: a verified custom-format dump plus the uploaded files, sent
// to the existing object store (Tencent COS through its S3-compatible API, AWS Signature V4) under
// daily/ (Sundays also weekly/, the 1st also monthly/). A few local copies are kept.
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config, credential, environmentValue } from "../config.ts";
import { sql } from "../db.ts";
import { backupDatabaseUrl } from "../db-bootstrap.ts";

const run = promisify(execFile);
const KEEP_LOCAL = 3;
const BACKUP_RESERVE = 1024 ** 3;
const localBackupEnabled = () => environmentValue("DB_BACKUP_LOCAL_ENABLED") === "true";

/** Every growing backup output retains the same reserve, including persistent-file archives. */
async function withSpaceReserve<T>(directory: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const check = async () => {
    const space = await statfs(directory);
    if (space.bavail * space.bsize < BACKUP_RESERVE) controller.abort();
  };
  await check();
  const guard = setInterval(() => {
    void check().catch(() => controller.abort());
  }, 1000);
  guard.unref();
  try {
    if (controller.signal.aborted) throw new Error("reserve");
    return await action(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Backup stopped to preserve free disk space; the previous verified backup is retained.");
    throw error;
  } finally {
    clearInterval(guard);
  }
}
async function persistentBytes(file: string): Promise<number> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let bytes = 0;
  for (const name of await readdir(file)) bytes += await persistentBytes(path.join(file, name));
  return bytes;
}
const archiveEnvironment = () =>
  Object.fromEntries(
    ["PATH", "HOME", "LANG", "LC_ALL"].flatMap((name) => {
      const value = environmentValue(name);
      return value === undefined ? [] : [[name, value]];
    }),
  );

/** A password file keeps the database credential out of argv and child-process error messages. */
async function dumpDatabase(file: string) {
  const address = new URL(backupDatabaseUrl());
  const password = decodeURIComponent(address.password);
  address.password = "";
  const dir = await mkdtemp(path.join(tmpdir(), "amp-backup-auth-"));
  try {
    const env = Object.fromEntries(
      [
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "PGPASSFILE",
        "PGSSLMODE",
        "PGSSLROOTCERT",
        "PGSSLCERT",
        "PGSSLKEY",
        "PGSSLCRL",
        "PGSSLCRLDIR",
        "PGSERVICE",
        "PGSERVICEFILE",
      ].flatMap((name) => {
        const value = environmentValue(name);
        return value === undefined ? [] : [[name, value]];
      }),
    );
    if (password) {
      if (/[\r\n]/.test(password)) throw new Error("Unsupported backup credential format");
      const passfile = path.join(dir, "pgpass");
      await writeFile(passfile, `*:*:*:*:${password.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\n`, { mode: 0o600, flag: "wx" });
      env.PGPASSFILE = passfile;
    }
    await withSpaceReserve(path.dirname(file), async (signal) => {
      try {
        await run("pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--file", file, address.href], {
          env,
          signal,
          maxBuffer: 16 * 1024 * 1024,
        });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const status = typeof code === "number" || ["ENOENT", "EACCES", "ETIMEDOUT"].includes(String(code)) ? String(code) : "failed";
        // Never persist execFile's argv, stderr or cause.
        throw new Error(`Database backup failed (pg_dump: ${status}); check the backup connection, permissions and available storage.`);
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Store {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  endpoint: string;
}

/** Backups run where the object store is configured (production); development never uploads. */
export function backupConfigured(): boolean {
  return store() !== null || localBackupEnabled();
}

function store(): Store | null {
  const get = (k: string) => process.env[k] || credential("integrations", k) || null;
  const secretId = get("DB_BACKUP_STORE_SECRET_ID");
  const secretKey = get("DB_BACKUP_STORE_SECRET_KEY");
  const bucket = get("DB_BACKUP_STORE_BUCKET");
  const region = get("DB_BACKUP_STORE_REGION");
  if (!secretId || !secretKey || !bucket || !region) return null;
  const domain = get("DB_BACKUP_STORE_DOMAIN");
  return {
    secretId,
    secretKey,
    bucket,
    region,
    endpoint: domain ? `https://${domain.replace(/^https?:\/\//, "")}` : `https://${bucket}.cos.${region}.myqcloud.com`,
  };
}

const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** AWS Signature V4 headers for one request (exported for the test vector check). */
export function signV4(opts: {
  method: string;
  url: URL;
  region: string;
  service?: string;
  accessKey: string;
  secretKey: string;
  payloadHash: string;
  headers?: Record<string, string>;
  now?: Date;
}): Record<string, string> {
  const now = opts.now ?? new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const service = opts.service ?? "s3";
  const headers: Record<string, string> = { ...(opts.headers ?? {}), host: opts.url.host, "x-amz-content-sha256": opts.payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalQuery = [...opts.url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonicalPath = opts.url.pathname
    .split("/")
    .map((s) => encodeURIComponent(decodeURIComponent(s)))
    .join("/");
  const canonical = [opts.method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), opts.payloadHash].join("\n");
  const scope = `${day}/${opts.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretKey}`, day), opts.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

async function fileSha256(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function upload(s: Store, key: string, file: string, sha: string, size: number) {
  const url = new URL(`${s.endpoint}/${key}`);
  const headers = signV4({
    method: "PUT",
    url,
    region: s.region,
    accessKey: s.secretId,
    secretKey: s.secretKey,
    payloadHash: sha,
    headers: { "content-length": String(size), "content-type": "application/octet-stream" },
  });
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: createReadStream(file) as never,
    duplex: "half",
    signal: AbortSignal.timeout(60 * 60_000),
  } as RequestInit);
  if (!res.ok) throw new Error(`backup upload ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export async function runBackup(now = new Date()) {
  const s = store();
  const dir = environmentValue("AMP_BACKUP_DIR") || path.join(config.dataDir, "backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const kept: string[] = [];
  // Feedback screenshots stay out of backups, so erasing one (admin/feedback.ts) leaves no copy behind.
  for (const d of ["uploads", "site/release-notes.json", "site/release-notes.json.announcements.json"])
    if (
      await stat(path.join(config.dataDir, d)).then(
        (i) => i.isDirectory() || i.isFile(),
        () => false,
      )
    )
      kept.push(d);
  const fileBytes = (await Promise.all(kept.map((name) => persistentBytes(path.join(config.dataDir, name))))).reduce((a, b) => a + b, 0);
  const stamp = `${now.toISOString().replace(/[-:T.Z]/g, "")}-${randomBytes(4).toString("hex")}`;
  const dump = path.join(dir, `amp-${stamp}.dump`);
  const space = await statfs(dir);
  const older = (await readdir(dir))
    .filter((name) => /^amp-\d{12,17}(?:-[a-f0-9]{8})?\.dump$/.test(name))
    .sort()
    .at(-1);
  const estimate = older ? Math.ceil((await stat(path.join(dir, older))).size * 1.25) : BACKUP_RESERVE;
  if (space.bavail * space.bsize < estimate + Math.ceil(fileBytes * 1.05) + BACKUP_RESERVE)
    throw new Error("Database backup deferred: free space is below the measured dump and persistent-file estimate plus the recovery reserve.");
  const pendingDump = `${dump}.partial-${process.pid}`;
  try {
    await dumpDatabase(pendingDump);
    await run("pg_restore", ["--list", pendingDump], { env: archiveEnvironment(), maxBuffer: 64 * 1024 * 1024 });
    await rename(pendingDump, dump);
  } finally {
    await rm(pendingDump, { force: true });
  }
  const files = path.join(dir, `amp-files-${stamp}.tar.gz`);
  const pendingFiles = `${files}.partial`;
  // An empty archive only when there is nothing to keep. A failure to read or pack existing files is
  // tried once more and otherwise reported: the database dump still ships, but the run fails.
  let filesError: string | null = null;
  const pack = () =>
    withSpaceReserve(dir, (signal) =>
      run("tar", kept.length ? ["-czf", pendingFiles, "-C", config.dataDir, ...kept] : ["-czf", pendingFiles, "-T", "/dev/null"], {
        env: archiveEnvironment(),
        signal,
      }),
    );
  await pack()
    .catch(() => pack())
    .catch(() => {
      filesError = "persistent_files_archive_failed";
    });
  if (filesError) await rm(pendingFiles, { force: true });
  else await rename(pendingFiles, files);
  const out: Array<{ key: string; bytes: number; sha256: string }> = [];
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const prefixes = ["daily"];
  if (s && bj.getUTCDay() === 0) prefixes.push("weekly");
  if (s && bj.getUTCDate() === 1) prefixes.push("monthly");
  for (const file of filesError ? [dump] : [dump, files]) {
    const size = (await stat(file)).size;
    const sha = await fileSha256(file);
    for (const p of prefixes) {
      // One prefix per retention class (daily/, weekly/, monthly/): a store's lifecycle rules can expire
      // each on its own schedule.
      const key = `${p}/${path.basename(file)}`;
      if (s) await upload(s, key, file, sha, size);
      out.push({ key: s ? key : `local-only:${path.basename(file)}`, bytes: size, sha256: sha });
    }
  }
  const version = environmentValue("AMP_RELEASE");
  const summary = {
    at: now.toISOString(),
    programRelease: version && /^[a-f0-9]{12,40}$/.test(version) ? version : null,
    destination: s ? "object-store" : "local",
    uploaded: !!s && !filesError,
    objects: out,
    ...(filesError ? { filesError } : {}),
  };
  await writeFile(path.join(dir, `amp-manifest-${stamp}.json`), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  // Remove only earlier generated copies after the new files and their hashes exist.
  for (const kind of filesError ? [] : ["amp-2", "amp-files-", "amp-manifest-"]) {
    const list = (await readdir(dir))
      .filter((f) => f.startsWith(kind))
      .filter((f) => /^amp-(?:files-|manifest-)?\d{12,17}(?:-[a-f0-9]{8})?\.(?:dump|tar\.gz|json)$/.test(f))
      .sort()
      .reverse();
    for (const f of list.slice(!s && localBackupEnabled() ? 1 : KEEP_LOCAL)) await rm(path.join(dir, f), { force: true });
  }
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('backup.last', ${sql.json(summary as never)}, 'backup')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  if (!s && !localBackupEnabled()) throw new Error("backup made locally but not uploaded: object store credentials are not configured");
  if (filesError) throw new Error(`database backed up, but the file archive failed: ${filesError}`);
  return summary;
}
