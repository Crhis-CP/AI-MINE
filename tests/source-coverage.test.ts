import assert from "node:assert/strict";
import { test } from "node:test";
import { SOURCE_TARGETS } from "@amp/industry/source-targets";
import { POLICY_SOURCES } from "@amp/industry/policy-sources";
import { SourceCoverage, SourceTargetExport } from "@amp/contracts/http/private";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { injectDb } from "@amp/backend/db";
import { sourceCoverage, sourceTargetExportData } from "../packages/backend/src/sources/coverage-matrix.ts";
import { sourceTargets } from "../packages/backend/src/sources/target-catalogue.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { SESSION_COOKIE } from "@amp/backend/admin/auth";
import { sha256 } from "@amp/backend/lib/ids";
import { config } from "@amp/backend/config";

test("three matrices preserve exact original exceptions, unresolved gaps and independent configuration evidence", async (t) => {
  const f = await publicRoleFixture(t),
    roles = await f.login();
  const restore = injectDb({
    sources: roles.private_ops,
    acquisition: roles.private_ops,
    content: roles.private_ops,
    publication: roles.private_ops,
    policy: roles.private_ops,
    identity: roles.auth,
  });
  t.after(restore);
  let result = await sourceCoverage();
  const china = result.matrices.find((m) => m.id === "china")!;
  assert.equal(china.rows.length, 15);
  const ids = new Set(china.cells.flatMap((c) => c.entries.map((e) => e.id)));
  assert.equal(ids.size, 253);
  assert.equal(
    china.cells.filter((c) => c.row === "CN-SX").reduce((n, c) => n + c.entries.length, 0),
    18,
  );
  assert.equal(
    china.cells.filter((c) => c.row === "CN-XZ").reduce((n, c) => n + c.entries.length, 0),
    14,
  );
  assert.equal(china.cells.find((c) => c.row === "CN-XZ" && c.column === "finance")!.entries.length, 0);
  const news = result.matrices.find((m) => m.id === "news")!;
  assert.equal(news.rows.length, 18);
  const wrong = SOURCE_TARGETS.find((t) => t.record_ids.includes("S16-R062"))!;
  assert.ok(
    !news.cells
      .filter((c) => c.row === "KZ")
      .flatMap((c) => c.entries)
      .some((e) => e.id === wrong.target_id),
  );
  assert.equal((await sourceTargets({})).coverage.find((c) => c.country === "KZ")!.total, 5);
  const policy = result.matrices.find((m) => m.id === "policy")!;
  assert.equal(policy.rows.length, 36);
  assert.equal(policy.columns.length, 7);
  assert.equal(policy.cells.length, 252);
  assert.ok(policy.cells.every((c) => c.configured === 0 && c.observed === 0));
  const source = POLICY_SOURCES.find((s) => s.themes.length && s.entry.startsWith("https://"))!;
  await f.admin`INSERT INTO sources(id,name,kind,lane,config,enabled) VALUES('matrix-policy','Synthetic matrix policy','web_list','policy',${f.admin.json({ url: source.entry, secret: "NEVER_EXPORT_MATRIX_SECRET" })},false)`;
  result = await sourceCoverage();
  const cell = result.matrices.find((m) => m.id === "policy")!.cells.find((c) => c.row === source.jurisdiction && c.column === source.themes[0])!;
  assert.equal(cell.configured, 1);
  assert.equal(cell.observed, 0);
  assert.ok(result.supplemental.some((s) => s.id === "matrix-policy"));
  assert.doesNotMatch(JSON.stringify(result), /NEVER_EXPORT_MATRIX_SECRET/);
  const exp = SourceTargetExport.parse(await sourceTargetExportData());
  assert.equal(exp.total, 320);
  assert.equal(exp.content.split("\r\n").length, 322);
  assert.ok(exp.content.startsWith("\uFEFF"));
  assert.doesNotMatch(exp.content, /NEVER_EXPORT_MATRIX_SECRET|old_source_id/);
  const app = await buildApp("private-api");
  t.after(() => app.close());
  const headers: Record<string, Record<string, string>> = {};
  for (const role of ["owner", "admin"]) {
    const [user] = await roles.auth`INSERT INTO admin_users(email,display_name) VALUES(${`matrix-${role}@synthetic.invalid`},${role}) RETURNING id`;
    await roles.auth`INSERT INTO identity.account_access(user_id,role,must_change_password) VALUES(${user.id},${role},false)`;
    await roles.auth`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(`matrix-${role}`)},${user.id},'synthetic-csrf',now()+interval '1 hour')`;
    headers[role] = {
      cookie: `${SESSION_COOKIE}=matrix-${role}`,
      "x-csrf-token": "synthetic-csrf",
      ...(config.privateHost ? { "x-forwarded-host": config.privateHost } : {}),
    };
  }
  const read = await app.inject({ url: "/api/admin/source-coverage", headers: headers.owner });
  assert.equal(read.statusCode, 200, read.body);
  SourceCoverage.parse(read.json());
  const denied = await app.inject({ url: "/api/admin/source-targets/export", method: "POST", headers: headers.admin, payload: {} });
  assert.equal(denied.statusCode, 403);
  const exported = await app.inject({ url: "/api/admin/source-targets/export", method: "POST", headers: headers.owner, payload: {} });
  assert.equal(exported.statusCode, 200, exported.body.slice(0, 300));
  SourceTargetExport.parse(exported.json());
  assert.equal(Number((await f.admin`SELECT count(*) AS n FROM audit_log WHERE action='source_targets.export'`)[0].n), 1);
  assert.equal(Number((await f.admin`SELECT count(*) AS n FROM receipt_attempts`)[0].n), 0);
});
