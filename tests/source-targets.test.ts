import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SOURCE_TARGETS, SOURCE_RECORDS } from "@amp/industry/source-targets";
import { sourceTargets } from "../packages/backend/src/sources/target-catalogue.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { injectDb } from "@amp/backend/db";
import { buildApp } from "../apps/api/src/app.ts";
import { SESSION_COOKIE } from "@amp/backend/admin/auth";
import { sha256 } from "@amp/backend/lib/ids";
import { config } from "@amp/backend/config";
import { SourceTargetsResponse } from "@amp/contracts/http/private";

test("original identities retain 321-to-320 traceability without loading old runtime or candidate configuration", () => {
  assert.equal(SOURCE_TARGETS.length, 320);
  assert.equal(SOURCE_RECORDS.length, 321);
  const lineage = SOURCE_TARGETS.flatMap((r) => r.record_ids);
  assert.equal(new Set(lineage).size, 321);
  assert.deepEqual([...lineage].sort(), SOURCE_RECORDS.map((r) => r.record_id).sort());
  const runtime = JSON.parse(readFileSync(new URL("../industry/source-targets.json", import.meta.url), "utf8"));
  for (const row of [...runtime.records, ...runtime.targets])
    for (const key of Object.keys(row))
      assert.ok(!/old_|candidate|permission|observation|runtime_source|discovery_status|completion|continuous_supply/.test(key), key);
});

test("real private role sees source evidence in separate dimensions; no historical status or similar-domain match becomes completion", async (t) => {
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
  const initial = await sourceTargets({});
  assert.equal(initial.total_targets, 320);
  assert.equal(initial.total_original_records, 321);
  assert.equal(initial.counts.observed, 0);
  assert.equal(initial.items.length, 50);
  const target = SOURCE_TARGETS.find((r) => r.primary_country === "CN" && typeof r.normalized_url === "string" && r.normalized_url.startsWith("http"))!;
  const url = target.normalized_url,
    other = new URL(url);
  other.pathname = "/a-different-collection";
  await f.admin`INSERT INTO sources(id,name,kind,lane,config,enabled,health) VALUES('target-evidence','Synthetic current source','web_list','news',${f.admin.json({ url, itemSelector: "article" })},false,'paused'),('target-similar','Do not associate similar domains','web_list','news',${f.admin.json({ url: other.toString() })},true,'ok')`;
  const selected = () => sourceTargets({ q: target.institution[0] });
  let found = (await selected()).items.find((r) => r.id === target.target_id)!;
  assert.equal(found.state, "configured");
  assert.deepEqual(
    found.sources.map((s) => s.source_id),
    ["target-evidence"],
  );
  assert.equal(found.sources[0].material_records, 0);
  await f.admin`INSERT INTO fetch_runs(source_id,status,finished_at,found_count,new_count) VALUES('target-evidence','ok',now(),1,0)`;
  found = (await selected()).items.find((r) => r.id === target.target_id)!;
  assert.equal(found.state, "observed");
  assert.equal(found.sources[0].fetch_successes_7d, 1);
  assert.equal(found.sources[0].body_records, 0);
  assert.equal(found.sources[0].publication_records, 0);
  await f.admin`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,body_status) VALUES('target-material','target-evidence','target-material',${url},'Synthetic material',now(),now(),'unconfirmed')`;
  found = (await selected()).items.find((r) => r.id === target.target_id)!;
  assert.equal(found.sources[0].material_records, 1);
  assert.equal(found.sources[0].body_records, 0);
  await f.admin`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,visibility) VALUES('target-material','Synthetic withdrawn record','target-evidence','news',${url},now(),now(),now(),'withdrawn')`;
  found = (await selected()).items.find((r) => r.id === target.target_id)!;
  assert.equal(found.sources[0].publication_records, 1);
  assert.equal(found.sources[0].enabled, false);
  assert.ok(!("complete" in found));
  const [user] = await roles.auth`INSERT INTO admin_users(email,display_name) VALUES('target-reader@synthetic.invalid','Target reader') RETURNING id`;
  await roles.auth`INSERT INTO identity.account_access(user_id,role) VALUES(${user.id},'admin')`;
  await roles.auth`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256("target-reader")},${user.id},'synthetic-csrf',now()+interval '1 hour')`;
  const app = await buildApp("private-api");
  t.after(() => app.close());
  const headers = { cookie: `${SESSION_COOKIE}=target-reader`, ...(config.privateHost ? { "x-forwarded-host": config.privateHost } : {}) };
  const read = await app.inject({ url: "/api/admin/source-targets?country=CN&page=2", headers });
  assert.equal(read.statusCode, 200, read.body);
  const data = SourceTargetsResponse.parse(read.json());
  assert.equal(data.page, 2);
  assert.ok(data.items.every((r) => r.countries.includes("CN")));
  assert.doesNotMatch(read.body, /old_source_id|old_current_entry_url|candidate_entries|reviewed_runtime_source_ids/);
  assert.equal((await app.inject({ url: "/api/admin/source-targets?page=0", headers })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/admin/source-targets?unknown=1", headers })).statusCode, 400);
});
