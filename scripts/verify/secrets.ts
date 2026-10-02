// Stage `secrets` (docs/04-architecture/02-tech-stack.md 7.2; 06-security-and-access.md 6.1): every commit
// in the PR's range (base..head) is scanned twice, and any hit fails the stage.
//   1. trufflehog, the version pinned in tools.json, downloaded once into .tools/ and checked against its
//      sha256. It runs with --no-verification: every candidate counts, nothing is sent to the providers to
//      test it, and the executor needs no outbound access beyond the download.
//   2. The project's own rules over the added lines, for keys whose format no provider check covers:
//      private key blocks, Tencent Cloud SecretId, model provider keys, Feishu app secrets, URLs that carry a
//      user name and password.
// A line that holds a deliberate example can carry the marker `secret-scan:allow` with a reason.
// Findings are reported by rule, file and line; the matched text itself is never printed.
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { capture, type Log, ROOT, run, sha256File } from "./lib.ts";

interface Rule {
  id: string;
  what: string;
  re: RegExp;
  /** Returns false for a match that is a placeholder or a local address rather than a secret. */
  real?: (m: RegExpMatchArray) => boolean;
}

const PLACEHOLDER = /^(\$|%|\{|<|\*|x+$|\.\.\.|…|password$|passwd$|pass$|pwd$|secret$|changeme$|example$|redacted$)/i;
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|([\w-]+\.)*(example|test|invalid|localhost)|example\.(com|org|net))$/i;

export const RULES: readonly Rule[] = [
  { id: "private-key", what: "private key block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "tencent-secret-id", what: "Tencent Cloud SecretId", re: /\bAKID[0-9A-Za-z]{32}\b/ },
  { id: "model-api-key", what: "model provider key (sk-…)", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/ },
  { id: "google-api-key", what: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    id: "feishu-app-secret",
    what: "Feishu / Lark app secret",
    re: /\b(?:app_?secret|appSecret)\b["']?\s*[:=]\s*["']?([A-Za-z0-9]{32})\b/i,
  },
  {
    id: "credentials-in-url",
    what: "URL with a user name and password",
    re: /\b[a-z][a-z0-9+.-]{1,30}:\/\/([^\s:/@'"`<>(){}[\]]+):([^\s/@'"`<>(){}[\]]+)@([^\s/:?#'"`<>(){}[\]]+)/i,
    real: (m) => !PLACEHOLDER.test(m[2]) && !LOCAL_HOST.test(m[3]),
  },
];

export interface Finding {
  rule: string;
  file: string;
  line: number;
  commit: string;
}

/** Rule hits in one line of text (empty when the line carries `secret-scan:allow`). */
export function scanLine(text: string): string[] {
  if (text.includes("secret-scan:allow")) return [];
  const hits: string[] = [];
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m && (!rule.real || rule.real(m))) hits.push(rule.id);
  }
  return hits;
}

/** The project rules over the lines added by `git log -p` output (`%x01%H` before each commit). */
export function scanPatch(patch: string): Finding[] {
  const findings: Finding[] = [];
  let commit = "";
  let file: string | null = null;
  let line = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("\u0001")) {
      commit = raw.slice(1, 13);
      file = null;
    } else if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.slice(4).replace(/^b\//, "");
    } else if (raw.startsWith("@@ ")) {
      line = Number(raw.match(/\+(\d+)/)?.[1] ?? 0);
    } else if (raw.startsWith("+") && file) {
      for (const rule of scanLine(raw.slice(1))) findings.push({ rule, file, line, commit });
      line++;
    }
  }
  return findings;
}

const TOOLS = JSON.parse(readFileSync(path.join(import.meta.dirname, "tools.json"), "utf8")) as {
  trufflehog: { version: string; url: string; sha256: Record<string, string> };
};
export const TRUFFLEHOG_VERSION = TOOLS.trufflehog.version;

/** The pinned trufflehog binary, downloaded and checked on first use. */
async function trufflehog(log: Log, env: NodeJS.ProcessEnv): Promise<string> {
  const { version, url, sha256 } = TOOLS.trufflehog;
  const platform = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
  const want = sha256[platform];
  if (!want) throw new Error(`no pinned trufflehog build for ${platform} in scripts/verify/tools.json`);
  const dir = path.join(ROOT, ".tools", `trufflehog-${version}-${platform}`);
  const bin = path.join(dir, "trufflehog");
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    const tarball = path.join(dir, "trufflehog.tar.gz");
    const from = url.replaceAll("{version}", version).replaceAll("{platform}", platform);
    if ((await run("curl", ["-fsSL", "--retry", "3", "-o", tarball, from], { log, env })) !== 0) throw new Error(`could not download ${from}`);
    const got = sha256File(tarball);
    if (got !== want) throw new Error(`trufflehog download has sha256 ${got}, tools.json pins ${want}`);
    if ((await run("tar", ["-xzf", tarball, "-C", dir, "trufflehog"], { log, env })) !== 0) throw new Error("could not unpack trufflehog");
    chmodSync(bin, 0o755);
  }
  const v = await capture(bin, ["--version"], { log, env });
  if (!v.stdout.includes(version)) throw new Error(`.tools trufflehog reports "${v.stdout.trim()}", expected ${version}`);
  return bin;
}

export interface SecretScan {
  tool: string;
  version: string;
  range: string;
  findings: number;
  scanners: { trufflehog: number; project_rules: number };
}

/** The stage over commits `from..head` (`from` null: the whole history of head). */
export async function scanSecrets(from: string | null, head: string, log: Log, env: NodeJS.ProcessEnv, repo = ROOT): Promise<SecretScan> {
  const bin = await trufflehog(log, env);
  const args = ["git", `file://${repo}`, "--branch", head, "--no-verification", "--no-update", "--json", "--results=verified,unknown,unverified"];
  if (from) args.push("--since-commit", from);
  const th = await capture(bin, args, { log, env, timeoutMs: 15 * 60_000 });
  if (th.code !== 0) throw new Error(`trufflehog exited with ${th.code}`);
  let thFindings = 0;
  for (const text of th.stdout.split("\n").filter(Boolean)) {
    const r = JSON.parse(text) as { DetectorName?: string; SourceMetadata?: { Data?: { Git?: { file?: string; line?: number; commit?: string } } } };
    if (!r.DetectorName) continue;
    thFindings++;
    const g = r.SourceMetadata?.Data?.Git ?? {};
    log.line(`trufflehog: ${r.DetectorName} in ${g.file}:${g.line} (commit ${g.commit?.slice(0, 12)})`);
  }

  const range = from ? `${from}..${head}` : head;
  const patch = await capture("git", ["log", "--reverse", "--format=%x01%H", "-p", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", range], {
    log,
    env,
    cwd: repo,
  });
  if (patch.code !== 0) throw new Error("git log failed");
  const own = scanPatch(patch.stdout);
  for (const f of own) log.line(`project rule ${f.rule}: ${f.file}:${f.line} (commit ${f.commit})`);

  return {
    tool: "trufflehog + project rules (scripts/verify/secrets.ts)",
    version: TRUFFLEHOG_VERSION,
    range: from ? `${from.slice(0, 12)}..${head.slice(0, 12)}` : `${head.slice(0, 12)} (whole history)`,
    findings: thFindings + own.length,
    scanners: { trufflehog: thFindings, project_rules: own.length },
  };
}
