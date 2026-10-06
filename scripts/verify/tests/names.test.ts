// names: the upstream name, its brand colours and its ring loader are stopped outside the exception paths,
// in the build output and in what the site serves; upstream brand assets are stopped everywhere. The
// patterns come from names.json, so this file never spells them out.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { MCP_TOOL_NAMES } from "@amp/contracts/mcp";
import { checkNames, checkOutputs, checkOutputTree, exemption, fetchSiteOutputs, loadRules, mcpRequests, SITE_OUTPUTS } from "../names.ts";
import { trackedFiles } from "../toolchain.ts";
import { repo, scratch, write } from "./helpers.ts";

const rules = loadRules();
const [N, SPACED] = rules.names as [string, string];
const [COLOUR, , RING] = rules.marks as [string, string, string];
const LOGO = "upstream logo bytes";
const WORKFLOW = `name: check\n# ${N} smoke\n`;
const KEPT = Object.values(rules.exceptions)
  .flat()
  .find((e) => typeof e !== "string" && "upstream" in e) as { path: string; upstream: string } | undefined;
const OUTSIDE = "outside the exception paths of scripts/verify/names.json";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The source manifest with one brand asset and the upstream workflow kept verbatim. */
const manifest = () =>
  JSON.stringify({
    files: [{ path: `${rules.brand.prefixes[0]}logo.svg`, sha256: sha(LOGO) }, ...(KEPT ? [{ path: KEPT.upstream, sha256: sha(WORKFLOW) }] : [])],
  });

/** A tree with the source manifest and `files`; returns the root and its file list. */
function tree(files: Record<string, string>): { dir: string; files: string[] } {
  const dir = scratch();
  const all = { [rules.manifest]: manifest(), ...files };
  write(dir, all);
  return { dir, files: Object.keys(all) };
}

test("the name outside the exceptions is stopped; on an exception path, or as a reference to a handoff file, it is not", () => {
  const { dir, files } = tree({
    "apps/web/app/lib/keys.ts": `export const THEME = "${N}-theme";\nexport const NEXT = 1;\n`,
    NOTICE: `Built on ${N.toUpperCase()}.\n`,
    "docs/04-architecture/notes.md": `${N}\n`,
    "tasks/TASK-0009.md": `${N}\n`,
    "tasks/INDEX.md": `| TASK-0009 | ${N} |\n`,
    "scripts/baseline/run.sh": `# see docs/04-architecture/04-${N}-adoption.md 7.3 and upstream/${N}.lock.json\n`,
  });
  assert.deepEqual(checkNames(dir, files, rules), [`apps/web/app/lib/keys.ts:1: "${N}" ${OUTSIDE}`]);
  assert.equal(exemption(dir, "tasks/INDEX.md", rules), "4 governance records");
});

test("the upstream's own documents and images are not covered by the handoff package's exception", () => {
  const { dir, files } = tree({
    "docs/deploy.md": `# Deploy ${N}\n`,
    "docs/assets/screenshot.txt": `${N}\n`,
    "docs/02-rules/notes.md": `${N}\n`,
  });
  assert.deepEqual(checkNames(dir, files, rules).sort(), [`docs/assets/screenshot.txt:1: "${N}" ${OUTSIDE}`, `docs/deploy.md:1: "${N}" ${OUTSIDE}`]);
  assert.equal(exemption(dir, "docs/deploy.md", rules), null);
  assert.equal(exemption(dir, "docs/02-rules/notes.md", rules), "2 handoff package and its write-backs");
});

test("the spaced name and the marks are caught in any case, and in binary files", () => {
  const { dir, files } = tree({
    "README.md": `intro\n\n${SPACED.toUpperCase()} framework\n`,
    "apps/web/app/app.css": `a {\n  color: ${COLOUR.toUpperCase()};\n}\n`,
    "apps/web/app/root.tsx": `<${RING} size={12} />\n`,
    "industry/brand/icon.png": `\u0000PNG\u0000${N}\u0000`,
  });
  assert.deepEqual(checkNames(dir, files, rules).sort(), [
    `README.md:3: "${SPACED.toUpperCase()}" ${OUTSIDE}`,
    `apps/web/app/app.css:2: "${COLOUR.toUpperCase()}" ${OUTSIDE}`,
    `apps/web/app/root.tsx:1: "${RING}" ${OUTSIDE}`,
    `industry/brand/icon.png:1: "${N}" ${OUTSIDE}`,
  ]);
});

test("paths come from git as they are, so files with Chinese names are checked", () => {
  const dir = scratch();
  repo(dir, [{ [rules.manifest]: manifest(), "说明/读我.md": `${N}\n`, [`素材/${N}-图.txt`]: "x\n" }]);
  const files = trackedFiles(dir);
  assert.ok(files.includes("说明/读我.md"), files.join(", "));
  assert.deepEqual(checkNames(dir, files, rules).sort(), [`素材/${N}-图.txt: the path contains "${N}"`, `说明/读我.md:1: "${N}" ${OUTSIDE}`].sort());
});

test("a symbolic link is checked by the target path git stores, and a file that cannot be read is a problem", () => {
  const { dir, files } = tree({});
  mkdirSync(path.join(dir, "apps/web/vendor"), { recursive: true });
  symlinkSync(`../../../node_modules/${N}/index.js`, path.join(dir, "apps/web/link.js"));
  const problems = checkNames(dir, [...files, "apps/web/link.js", "apps/web/vendor", "apps/web/deleted.ts"], rules);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.equal(problems[0], `apps/web/link.js:1: "${N}" ${OUTSIDE}`);
  assert.match(problems[1]!, /^apps\/web\/vendor: cannot be read \(EISDIR/);
});

test("a governance file is covered only while it is byte-identical to its handoff template", () => {
  const template = `# rules\n${N} is the base.\n`;
  const same = tree({ "docs/06-agents/templates/root-AGENTS.md": template, "AGENTS.md": template });
  assert.deepEqual(checkNames(same.dir, same.files, rules), []);
  assert.equal(exemption(same.dir, "AGENTS.md", rules), "4 governance records");
  const edited = tree({ "docs/06-agents/templates/root-AGENTS.md": template, "AGENTS.md": `${template}one more line\n` });
  assert.deepEqual(checkNames(edited.dir, edited.files, rules), [
    `AGENTS.md:2: "${N}" ${OUTSIDE}`,
    "AGENTS.md: differs from docs/06-agents/templates/root-AGENTS.md, so the governance exception does not cover it",
  ]);
});

test("the upstream workflow is covered only while it has the upstream file's hash", () => {
  assert.ok(KEPT, "names.json has no exception conditioned on an upstream file");
  const same = tree({ [KEPT.path]: WORKFLOW });
  assert.deepEqual(checkNames(same.dir, same.files, rules), []);
  const edited = tree({ [KEPT.path]: `${WORKFLOW}# edited\n` });
  assert.deepEqual(checkNames(edited.dir, edited.files, rules), [
    `${KEPT.path}:2: "${N}" ${OUTSIDE}`,
    `${KEPT.path}: differs from the upstream ${KEPT.upstream} in ${rules.manifest}, so the exception does not cover it`,
  ]);
});

test("an upstream brand asset is stopped wherever it is, and a path that names the project is stopped", () => {
  const { dir, files } = tree({
    "docs/assets/banner.svg": LOGO,
    "docs/02-rules/logo.svg": LOGO,
    "apps/web/public/mark.svg": LOGO,
    [`apps/web/app/${N}.ts`]: "export {};\n",
  });
  assert.deepEqual(checkNames(dir, files, rules).sort(), [
    `apps/web/app/${N}.ts: the path contains "${N}"`,
    `apps/web/public/mark.svg: same bytes as the upstream brand asset ${rules.brand.prefixes[0]}logo.svg (no exceptions)`,
    `docs/02-rules/logo.svg: same bytes as the upstream brand asset ${rules.brand.prefixes[0]}logo.svg (no exceptions)`,
    `docs/assets/banner.svg: same bytes as the upstream brand asset ${rules.brand.prefixes[0]}logo.svg (no exceptions)`,
  ]);
});

test("the build output and the site's outputs have no exceptions, references to handoff files included", () => {
  const { dir } = tree({
    "apps/web/build/client/assets/root.css": `@keyframes ${N}-fade{to{opacity:0}}`,
    "apps/web/build/client/logo.svg": LOGO,
    "apps/web/build/client/notice.txt": `See upstream/${N}.lock.json\n`,
    "apps/web/build/server/index.js": "export default {};\n",
  });
  assert.deepEqual(checkOutputTree(path.join(dir, "apps/web/build"), dir, rules).sort(), [
    `apps/web/build/client/assets/root.css:1: "${N}" in the build output`,
    `apps/web/build/client/logo.svg: same bytes as the upstream brand asset ${rules.brand.prefixes[0]}logo.svg`,
    `apps/web/build/client/notice.txt:1: "${N}" in the build output`,
  ]);
  assert.deepEqual(
    checkOutputs(
      [
        { label: "/llms.txt (HTTP 200)", text: `# Site\n\nRuns on ${N.toUpperCase()}.\n` },
        { label: "/openapi-v1.json (HTTP 200)", text: `{"source":"upstream/${N}.lock.json"}` },
        { label: "/feed.xml (HTTP 200)", text: "<rss/>" },
      ],
      rules,
    ),
    [`/llms.txt (HTTP 200), line 3: "${N.toUpperCase()}"`, `/openapi-v1.json (HTTP 200), line 1: "${N}"`],
  );
});

const ALLOWED = rules.allowedPhrases ?? { phrases: {}, files: [], outputs: [] };
const PHRASES = Object.keys(ALLOWED.phrases);

test("the changelog's thanks phrases pass verbatim in the outputs names.json lists; anywhere else they are hits", () => {
  const phrases = PHRASES;
  assert.ok(phrases.length > 0);
  assert.deepEqual(ALLOWED.outputs, ["/changelog", "/api/site/changelog"]);
  assert.ok(SITE_OUTPUTS.some(([url]) => url === "/api/site/changelog"));
  const page = `<h3>${phrases.join("</h3>\n<p>")}</p>`;
  for (const output of ALLOWED.outputs) assert.deepEqual(checkOutputs([{ label: `${output} (HTTP 200)`, text: page }], rules), []);
  assert.equal(checkOutputs([{ label: "/about (HTTP 200)", text: page }], rules).length, phrases.length);
  assert.equal(checkOutputs([{ label: "/changelog-feed (HTTP 200)", text: page }], rules).length, phrases.length);
  assert.equal(checkOutputs([{ label: "/api/v1/items (HTTP 200)", text: page }], rules).length, phrases.length);
  // One character changed outside the name, or the name once more on the page: hits again.
  const changed = phrases.map((p) => `某${p.slice(1)}`);
  assert.ok(changed.every((p) => !phrases.includes(p) && p.toLowerCase().includes(N)));
  assert.equal(checkOutputs([{ label: "/changelog (HTTP 200)", text: changed.join("\n") }], rules).length, phrases.length);
  assert.deepEqual(checkOutputs([{ label: "/changelog (HTTP 200)", text: `${page}\n${N}` }], rules), [
    `/changelog (HTTP 200), line ${phrases.length + 1}: "${N}"`,
  ]);
});

test("in the changelog data file (exception 7) the thanks phrases, each as many times as names.json says, are the only hits allowed", () => {
  const [file] = ALLOWED.files as [string];
  assert.equal(exemption(scratch(), file, rules), "7 thanks in the changelog");
  const entries = (lines: string[]) => JSON.stringify({ releases: lines.map((l) => ({ body: [l] })) }, null, 2);
  const counted = Object.entries(ALLOWED.phrases).flatMap(([p, n]) => Array<string>(n).fill(p));
  const ok = tree({ [file]: entries(counted) });
  assert.deepEqual(checkNames(ok.dir, ok.files, rules), []);
  const BEYOND = "outside the allowed phrases of scripts/verify/names.json";
  const more = tree({ [file]: entries([...counted, `${N} again`, `某${PHRASES[0]!.slice(1)}`]) });
  const problems = checkNames(more.dir, more.files, rules);
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => p.startsWith(`${file}:`) && p.endsWith(BEYOND)));
  // A phrase written once more in another entry, or one left out: the counts no longer match.
  const [first] = PHRASES as [string];
  for (const lines of [[...counted, first], counted.filter((l) => l !== first)]) {
    const changed = tree({ [file]: entries(lines) });
    const found = checkNames(changed.dir, changed.files, rules);
    assert.equal(found.length, 1);
    assert.match(
      found[0]!,
      new RegExp(`^${file}: ".+" appears ${lines.filter((l) => l === first).length} times, scripts/verify/names.json allows ${ALLOWED.phrases[first]}$`),
    );
  }
});

/** The text with its first letter written as a JSON \uXXXX escape. */
const escapeFirst = (text: string) => text.replace(/[a-z]/i, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

test("a JSON file is read with its \\uXXXX escapes decoded; an escaped backslash stays, and hits keep the file's lines", () => {
  // Exception 7: the first phrase once more, its name's first letter escaped, is counted (review of #165, item 12).
  const [file] = ALLOWED.files as [string];
  const [first] = PHRASES as [string];
  const counted = Object.entries(ALLOWED.phrases).flatMap(([p, n]) => Array<string>(n).fill(p));
  const changelog = JSON.stringify({ releases: [...counted, "@"].map((l) => ({ body: [l] })) }, null, 2).replace('"@"', `"${escapeFirst(first)}"`);
  const seven = tree({ [file]: changelog });
  assert.deepEqual(checkNames(seven.dir, seven.files, rules), [
    `${file}: "${first}" appears ${ALLOWED.phrases[first]! + 1} times, scripts/verify/names.json allows ${ALLOWED.phrases[first]}`,
  ]);
  // Any other JSON file: the name written as escapes is a hit (item 12b), on its own line after a decoded line break;
  // a backslash escaped before "u" starts no escape.
  const other = tree({ "apps/web/app/data.json": `{\n  "a": "one\\u000atwo",\n  "b": "${escapeFirst(N)}",\n  "c": "\\\\${escapeFirst(N).slice(1)}"\n}\n` });
  assert.deepEqual(checkNames(other.dir, other.files, rules), [`apps/web/app/data.json:3: "${N}" ${OUTSIDE}`]);
});

test("exception 7 and allowedPhrases.files must list the same files", () => {
  const [file] = ALLOWED.files as [string];
  const seven = Object.keys(rules.exceptions).find((name) => rules.exceptions[name]!.includes(file))!;
  const { dir, files } = tree({});
  const lists = (excepted: string[], counted: string[]) =>
    checkNames(dir, files, { ...rules, exceptions: { ...rules.exceptions, [seven]: excepted }, allowedPhrases: { ...ALLOWED, files: counted } });
  const differ = `scripts/verify/names.json: exception "${seven}" and allowedPhrases.files must list the same files`;
  assert.deepEqual(lists([file, "industry/more.json"], [file]), [`${differ} (only in the exception: industry/more.json; only in allowedPhrases.files: none)`]);
  assert.deepEqual(lists([file], [file, "industry/more.json"]), [`${differ} (only in the exception: none; only in allowedPhrases.files: industry/more.json)`]);
  assert.deepEqual(lists([file], [file]), []);
});

test("the site's outputs are fetched whole with their statuses checked, the changes feed by the snapshot's cursor, every MCP tool once, and error results only where allowed", async () => {
  const called: string[] = [];
  const privateHost = "private.brand.test:8443";
  const loginHosts: string[] = [];
  let loginMode = "ok";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://site");
    if (req.method === "POST" && url.pathname === "/api/mcp") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, params } = JSON.parse(body) as { id: number; params: { name?: string } };
        if (params.name) called.push(params.name);
        const failed = { isError: true, content: [{ type: "text", text: "not available" }] };
        const answer =
          params.name === MCP_TOOL_NAMES.story
            ? { error: { code: -32603, message: "failed" } }
            : { result: params.name === MCP_TOOL_NAMES.latest || params.name === MCP_TOOL_NAMES.daily ? failed : { content: [] } };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, ...answer })}\n\n`);
      });
      return;
    }
    const send = (status: number, body: string) => res.writeHead(status).end(body);
    if (url.pathname === "/admin/login") {
      loginHosts.push(req.headers.host ?? "");
      if (req.headers.host === privateHost) return send(loginMode === "private-missing" ? 404 : 200, `private ${N}`);
      if (loginMode === "public-cookie") res.setHeader("Set-Cookie", "unexpected=true");
      return send(loginMode === "public-open" ? 200 : 404, "not found");
    }
    if (url.pathname === "/api/v1/selected/snapshot") return send(200, JSON.stringify({ cursor: "c/1", items: [] }));
    if (url.pathname === "/api/v1/selected/changes") return url.searchParams.get("cursor") === "c/1" ? send(200, "changes since c/1") : send(409, "");
    if (url.pathname === "/hot") return send(500, "failed");
    if (url.pathname === "/no-such-page" || url.pathname === "/api/v1/dailies/latest") return send(404, "not found");
    return send(200, `page ${url.pathname}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const site = await fetchSiteOutputs(base, privateHost);
    assert.deepEqual(site.problems, [
      "/hot: HTTP 500, expected 200",
      `MCP tools/call ${MCP_TOOL_NAMES.latest}: an error result (not available)`,
      `MCP tools/call ${MCP_TOOL_NAMES.story}: HTTP 200, error {"code":-32603,"message":"failed"}`,
    ]);
    assert.equal(site.outputs.length, SITE_OUTPUTS.length + 2 + (await mcpRequests()).length);
    assert.deepEqual(loginHosts, [new URL(base).host, privateHost]);
    assert.deepEqual(checkOutputs(site.outputs, rules), [`private /admin/login (HTTP 200), line 1: "${N}"`]);
    const changes = site.outputs.find((o) => o.label.startsWith("/api/v1/selected/changes"));
    assert.deepEqual(changes, { label: "/api/v1/selected/changes?cursor=<snapshot cursor> (HTTP 200)", text: "changes since c/1" });
    assert.deepEqual(called.sort(), Object.values(MCP_TOOL_NAMES).sort());
    for (const [mode, problem] of [
      ["private-missing", "private /admin/login: HTTP 404, expected 200"],
      ["public-cookie", "/admin/login: public rejection set a cookie"],
      ["public-open", "/admin/login: HTTP 200, expected 404"],
    ] as const) {
      loginMode = mode;
      assert.ok((await fetchSiteOutputs(base, privateHost)).problems.includes(problem));
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
