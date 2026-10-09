import assert from "node:assert/strict";
import { test } from "node:test";
import { injectDb } from "@amp/backend/db";
import { SESSION_COOKIE } from "@amp/backend/admin/auth";
import { sha256 } from "@amp/backend/lib/ids";
import { config } from "@amp/backend/config";
import { SITE } from "@amp/industry/site";
import { SiteInformation, MetalPrices } from "@amp/contracts/http/public";
import { publicRoleFixture, publicServer } from "./public-role-fixture.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { denied } from "./role-db-fixture.ts";

test("Owner saves public site fields with session CSRF CAS idempotency and atomic audit; public_read observes fields without private commands", async (t) => {
  const f = await publicRoleFixture(t),
    dbs = await f.login(),
    dispose = injectDb({ publication: dbs.private_ops, identity: dbs.auth });
  t.after(dispose);
  const host = config.privateHost,
    dev = config.devAdmin;
  config.privateHost = "site-settings.test";
  config.devAdmin = null;
  const app = await buildApp("private-api");
  t.after(async () => {
    await app.close();
    config.privateHost = host;
    config.devAdmin = dev;
  });
  const base = { host: "private-api", "x-forwarded-host": "site-settings.test" };
  async function identity(name: string, role: "owner" | "admin") {
    const [row] = await dbs.auth`INSERT INTO admin_users(display_name) VALUES(${name}) RETURNING id`;
    await dbs.auth`INSERT INTO identity.account_access(user_id,role) VALUES(${row.id},${role})`;
    const token = `synthetic-${name}`;
    await dbs.auth`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(token)},${row.id},'site-csrf',now()+interval '1 hour')`;
    return { ...base, cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": "site-csrf", "idempotency-key": "site-information-command-1" };
  }
  const owner = await identity("site-owner", "owner"),
    admin = await identity("site-admin", "admin");
  assert.equal((await app.inject({ url: "/api/admin/site", headers: base })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/admin/site", headers: admin })).statusCode, 403);
  const initial = await app.inject({ url: "/api/admin/site", headers: owner });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().information.revision, 0);
  assert.equal(initial.json().protected.icp.configured, !!SITE.icp);
  assert.equal(initial.json().protected.newsLicenseValidUntil, null);
  if (SITE.icp) assert.ok(!initial.body.includes(SITE.icp));
  assert.ok(!("name" in initial.json().information));
  const payload = {
    expected_revision: 0,
    about: "合成网站介绍\n<script>只是文字</script>",
    contactEmail: "contact@synthetic.test",
    contactPage: "https://synthetic.test/contact",
    metalLinks: [{ name: "合成官方入口", url: "https://synthetic.test/metals", note: "仅用于隔离测试的查询入口" }],
  };
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/site", headers: { ...owner, "x-csrf-token": "" }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/api/admin/site", headers: owner, payload: { ...payload, icp: "forbidden" } })).statusCode, 400);
  assert.equal(
    (await app.inject({ method: "PUT", url: "/api/admin/site", headers: owner, payload: { ...payload, contactPage: "http://synthetic.test" } })).statusCode,
    400,
  );
  const saved = await app.inject({ method: "PUT", url: "/api/admin/site", headers: owner, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  const information = SiteInformation.parse(saved.json());
  assert.equal(information.revision, 1);
  const replay = await app.inject({ method: "PUT", url: "/api/admin/site", headers: owner, payload });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), information);
  assert.equal(
    (await app.inject({ method: "PUT", url: "/api/admin/site", headers: owner, payload: { ...payload, about: "changed under the same command" } })).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ method: "PUT", url: "/api/admin/site", headers: { ...owner, "idempotency-key": "stale-command-new" }, payload })).statusCode,
    409,
  );
  const audits = await f.admin`SELECT before,after FROM audit_log WHERE action='site.information.save'`;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].before.revision, 0);
  assert.equal(audits[0].after.about, payload.about);
  const server = await publicServer(t, f),
    read = await server.request("/api/site/information");
  assert.equal(read.status, 200);
  assert.deepEqual(SiteInformation.parse(await read.json()), information);
  const prices = await server.request("/api/site/metal-prices");
  assert.equal(prices.status, 200);
  assert.deepEqual(MetalPrices.parse(await prices.json()).officialLinks, payload.metalLinks);
  assert.match(await (await server.request("/.well-known/security.txt")).text(), /contact@synthetic.test/);
  assert.match(await (await server.request("/llms.txt")).text(), /contact@synthetic.test/);
  assert.equal((await server.request("/api/admin/site")).status, 404);
  await denied(dbs.public_read, "SELECT * FROM publication.site_information_commands");
  await denied(dbs.public_read, "UPDATE publication.site_information SET revision=999 WHERE id=1");
  const empty = { ...payload, expected_revision: 1, about: "", contactEmail: null, contactPage: null, metalLinks: [] };
  const cleared = await app.inject({ method: "PUT", url: "/api/admin/site", headers: { ...owner, "idempotency-key": "site-clear-command" }, payload: empty });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal((await server.request("/.well-known/security.txt")).status, 404);
  const visible = SiteInformation.parse(await (await server.request("/api/site/information")).json());
  assert.equal(visible.about, "");
  assert.equal(visible.contactEmail, null);
  assert.equal(visible.contactPage, null);
  assert.deepEqual(MetalPrices.parse(await (await server.request("/api/site/metal-prices")).json()).officialLinks, []);
  // A failing audit rolls the public save and command record back in the same business transaction.
  await f.admin.unsafe(`REVOKE INSERT ON audit_log FROM "${f.roles.private_ops}"`);
  const failed = await app.inject({
    method: "PUT",
    url: "/api/admin/site",
    headers: { ...owner, "idempotency-key": "site-audit-failed" },
    payload: { ...payload, expected_revision: 2 },
  });
  assert.equal(failed.statusCode, 500);
  assert.equal((await f.admin`SELECT revision FROM publication.site_information WHERE id=1`)[0].revision, 2);
  assert.equal((await f.admin`SELECT count(*)::int n FROM publication.site_information_commands WHERE request_key='site-audit-failed'`)[0].n, 0);
});

test("protected expiry reads only the recorded date, uses Beijing days and never invents missing licence information", async () => {
  const { protectedSiteInformation } = await import("../packages/backend/src/site/protected-information.ts");
  delete process.env.NEWS_LICENSE_VALID_UNTIL;
  assert.equal(protectedSiteInformation().newsLicenseDateState, "not_recorded");
  process.env.NEWS_LICENSE_VALID_UNTIL = "2026-02-30";
  assert.equal(protectedSiteInformation().newsLicenseDateState, "invalid");
  assert.equal(protectedSiteInformation().remainingDays, null);
  process.env.NEWS_LICENSE_VALID_UNTIL = "2026-10-10";
  const state = protectedSiteInformation(new Date("2026-10-09T16:01:00Z"));
  assert.equal(state.remainingDays, 0);
  assert.equal(state.newsLicenseValidUntil, "2026-10-10");
  assert.equal(state.newsLicense.configured, !!SITE.newsLicense);
  delete process.env.NEWS_LICENSE_VALID_UNTIL;
});
