import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createDatabaseAccess } from "@amp/backend/db";
import { newShortId } from "@amp/backend/lib/ids";
import { Policy, PolicyCard, PolicyListQuery } from "@amp/contracts/http/public";
import { installTestConnections } from "./direct-db-fixture.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { appendSourcePolicy } from "../packages/backend/src/sources/permission-store.ts";
import { recordPolicyOriginal } from "../modules/policy/backend/domain/originals.ts";
import { POLICY_MODEL_BINDING_VERSION } from "../modules/policy/backend/domain/model-evidence.ts";
import { listPolicies, policyCurrentPublicRecords, policyScope } from "../modules/policy/backend/read.ts";

const access = createDatabaseAccess("test", { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: "4" }, () => {});
const db = access.dbFor("worker");
// Every tagged statement (and fragment) the reads build through the shared driver handle.
let statements = 0;
const counted = new Proxy(db, {
  apply(target, self, args) {
    if (Array.isArray(args[0]) && Object.hasOwn(args[0], "raw")) statements++;
    return Reflect.apply(target, self, args);
  },
});
const dispose = installTestConnections(counted);
after(async () => {
  dispose();
  await access.close();
});

const complete = () => JSON.parse(readFileSync(new URL("./fixtures/policy-public/complete.json", import.meta.url), "utf8"));
const basicFacts = JSON.parse(readFileSync(new URL("./fixtures/policy-public/basic-facts.json", import.meta.url), "utf8"));
const card = (policy: unknown) => {
  const p = Policy.parse(policy);
  return PolicyCard.parse(Object.fromEntries(Object.keys(PolicyCard.shape).map((k) => [k, p[k as keyof typeof p]])));
};

/** A policy source with its permission and an applied catalogue, and `documents` current documents discovered in it. */
async function source(label: string, documents: number) {
  const sourceId = `policy-batch-${label}`,
    host = `${label}.gov.invalid`;
  await db`INSERT INTO sources(id,name,kind,lane) VALUES(${sourceId},${sourceId},'external','policy')`;
  const policy = structuredClone(sourcePolicyExample);
  policy.source_id = sourceId;
  policy.scope = { hosts: [host], path_prefixes: ["/"], document_types: [], excluded_content: [] };
  policy.evidence = policy.evidence.map((e) => ({ ...e, scope: policy.scope }));
  await db.begin((tx) => appendSourcePolicy(tx, null, policy));
  await db`INSERT INTO acquisition.directory_scans(id,source_id,contract_hash,permission_version,contract,state,next_page)
    VALUES(${`scan-${label}`},${sourceId},'h',1,'{}'::jsonb,'complete',1)`;
  const ids: string[] = [];
  for (let n = 0; n < documents; n++) {
    const id = `pol_${newShortId(12)}`,
      url = `https://${host}/decree/${n}`,
      material = `material-${label}-${n}`,
      dto = complete();
    dto.id = id;
    dto.ai_metadata.content_id = id;
    dto.original_url = url;
    await db`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${material},${sourceId},${material},${url},'t',now(),now())`;
    await db`INSERT INTO article_revisions(article_id,revision,title) VALUES(${material},1,'t')`;
    await db`INSERT INTO acquisition.directory_records(scan_id,record_id,page_number,identity_key,role,url,metadata_hash,first_seen_at,metadata)
      VALUES(${`scan-${label}`},${`record-${n}`},1,${material},'current',${url},'m',now(),'{}'::jsonb)`;
    await db`INSERT INTO acquisition.directory_bindings(scan_id,record_id,material_id,material_revision,wake_hash) VALUES(${`scan-${label}`},${`record-${n}`},${material},1,'w')`;
    const record = await recordPolicyOriginal({
      sourceId,
      permissionVersion: 1,
      identity: { jurisdiction: "AR", authority: sourceId, documentType: "decree", documentNumber: `${label}-${n}`, officialUrl: url },
      versionKey: "original",
      language: "en",
      kind: "original",
      officialTitle: `${dto.original_title} ${label} ${n}`,
      expectedHead: null,
      catalogueClosed: true,
      resources: [
        {
          url,
          mediaType: "text/html",
          attachment: false,
          required: true,
          state: "acquired",
          body: Buffer.from(`<p>Synthetic ${label} ${n}</p>`),
          reason: null,
        },
      ],
    });
    await db`INSERT INTO policy.material_discoveries(expression_id,material_id,source_id,material_revision,discovered_at) VALUES(${record.expressionId},${material},${sourceId},1,now())`;
    const basic = Policy.parse({
      ...basicFacts,
      id,
      ai_metadata: { ...basicFacts.ai_metadata, content_id: id },
      original_url: url,
      summary: null,
      versions: dto.versions.map((v: Record<string, unknown>) => ({ ...v, legal_brief: basicFacts.legal_brief })),
      expressions: dto.expressions,
      selected_policy_version_id: dto.selected_policy_version_id,
      selected_expression_id: dto.selected_expression_id,
      reading: null,
    });
    const quality = `quality-${label}-${n}`;
    await db`INSERT INTO publication.policy_documents(id,first_public_at) VALUES(${id},now())`;
    await db`INSERT INTO publication.policy_quality_windows(id,valid_until,binding_version) VALUES(${quality},now()+interval '1 day',${POLICY_MODEL_BINDING_VERSION})`;
    await db`INSERT INTO publication.policy_editions(id,content_hash,policy_id,native_expression_id,native_revision_id,source_id,permission_version,policy_version_id,source_language,preferred_source_language,
      expression_ids,revision_ids,public_resources,basic_card,basic_detail,complete_card,complete_detail,reading,quality_id)
      VALUES(${`edition-${label}-${n}`},${`${label}-${n}`},${id},${record.expressionId},${record.revisionId},${sourceId},1,${dto.selected_policy_version_id},'en','en',
      ${dto.expressions.map((e: { id: string }) => e.id)},${dto.expressions.map((e: { document_revision_id: string }) => e.document_revision_id)},
      ${db.json([{ url, document_type: "decree", attachment: false }])},${db.json(card(basic))},${db.json(basic)},${db.json(card(dto))},${db.json(dto)},${db.json({})},${quality})`;
    ids.push(id);
  }
  await db`INSERT INTO acquisition.directory_heads(source_id,scan_id,applied_at) VALUES(${sourceId},${`scan-${label}`},now())`;
  return ids;
}

/** The page-numbered list the site asks for (not the cursor form of the open API). */
async function page(query: Record<string, unknown>) {
  const result = await listPolicies(PolicyListQuery.parse(query));
  assert.ok("total" in result);
  return result;
}
/** Readable documents of one policy jurisdiction, as the policy scope reports them. */
async function readable(code: string) {
  const result = await policyScope();
  assert.ok(!Array.isArray(result));
  return result.items.find((item) => item.jurisdiction.code === code)?.readable_count;
}

async function counting<T>(read: () => Promise<T>) {
  await read(); // prepared statements and module state
  statements = 0;
  const value = await read();
  return { value, statements };
}

test("public policy lists read a page of documents with a fixed number of statements, shared while a read is under way", async () => {
  const first = [...(await source("a", 1)), ...(await source("b", 1))];
  const list = () => page({}),
    scope = () => policyScope(),
    records = () => policyCurrentPublicRecords();
  const small = { list: await counting(list), scope: await counting(scope), records: await counting(records) };
  assert.equal(small.list.value.total, 2);
  assert.equal(small.records.value.length, 2);
  // Three times the documents over twice the sources: permissions, heads and catalogue membership are read per page, not per document.
  const more = [...(await source("c", 2)), ...(await source("d", 2))];
  const large = { list: await counting(list), scope: await counting(scope), records: await counting(records) };
  assert.equal(large.list.value.total, 6);
  assert.deepEqual(new Set(large.list.value.items.map((item) => item.id)), new Set([...first, ...more]));
  assert.equal(await readable("AR"), 6);
  assert.equal(large.list.statements, small.list.statements);
  assert.equal(large.scope.statements, small.scope.statements);
  assert.equal(large.records.statements, small.records.statements);
  // A jurisdiction page asks for several lists and the scope at once; they share one reading of every document.
  statements = 0;
  const together = await Promise.all([
    page({ jurisdiction: "AR", page_size: 3 }),
    page({ jurisdiction: "AR", theme: "mineral_rights", page_size: 1 }),
    scope(),
  ]);
  assert.equal(together[0].total, 6);
  assert.ok(statements < large.list.statements + large.scope.statements, `${statements} statements for three concurrent reads`);
  // Nothing is kept once a read settles: a withdrawal is gone from the next list, and so is a document dropped from its catalogue.
  await db`UPDATE publication.policy_documents SET withdrawn=true WHERE id=${first[0]!}`;
  assert.equal((await list()).total, 5);
  await db`UPDATE acquisition.directory_records SET role='history' WHERE scan_id='scan-c' AND record_id='record-0'`;
  assert.equal((await list()).total, 4);
  assert.equal(await readable("AR"), 4);
});
