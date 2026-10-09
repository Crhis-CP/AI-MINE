import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { config } from "@amp/backend/config";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { createPolicyGateway, type PreparedPolicyInput } from "../packages/backend/src/providers/policy.ts";
import { readPolicyResponse } from "../packages/backend/src/providers/receipts.ts";
import { markReceiptsCompleted } from "../packages/backend/src/providers/llm.ts";
import {
  policyModelEvidence,
  policyModelQualification,
  policyModelQualificationKey,
  policyVisionContentHash,
} from "../packages/backend/src/policy/model-evidence.ts";
import { installPolicyQualityRelease, matchingPolicyQuality } from "../packages/backend/src/policy/quality.ts";
import { policyInterpretationQualityRecipe } from "../packages/backend/src/policy/references.ts";
import { sha256, stableJson } from "../packages/backend/src/lib/ids.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
const db = dbOf("ai-gateway"),
  root = await initializeDb("test");
const response = () => ({
  model: "same-reported-model",
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 3 },
});
const a = await stub(response),
  b = await stub(response);
after(async () => {
  await a.close();
  await b.close();
  await closeDb();
});
Object.assign(process.env, { LLM_API_KEY: "synthetic-only", LLM_MODEL: "same-requested-model" });
config.modelCallsEnabled = true;

test("actual physical response snapshots separate the same model name at distinct endpoints and reject logical-request substitutions", async () => {
  const sourceId = `model-binding-${tag()}`,
    url = `https://source.invalid/${sourceId}`;
  await db`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${sourceId},${sourceId},'external','policy',false)`;
  await grantDateFixture(sourceId, [url]);
  const input: PreparedPolicyInput = {
    manifest: {
      schema_version: 1,
      kind: "source_materials",
      lane: "policy",
      materials: [
        {
          source_id: sourceId,
          material_id: sourceId,
          revision: 1,
          content_hash: sha256("synthetic original"),
          resource: { url, document_type: null, attachment: false },
        },
      ],
      upstream_artifacts: [],
    },
    system: "Synthetic instructions",
    user: "Synthetic original",
    promptVersion: "synthetic@1",
    recipeVersion: "synthetic1",
    controlRevision: "1",
    processingAllowed: true,
  };
  const gateway = createPolicyGateway({ root, resolve: async () => structuredClone(input) }),
    request = () => gateway.chat({ input: { id: sourceId, version: "1" }, purpose: "policy_interpret", schema: z.object({ ok: z.boolean() }) });
  process.env.LLM_BASE_URL = `${a.url}/v1`;
  await installUsageFixtureForModel("default", db);
  const first = await request();
  await markReceiptsCompleted([first.receiptId]);
  const firstProof = await readPolicyResponse({ receiptId: first.receiptId, attemptId: first.attemptId! });
  assert.ok(firstProof?.configuration_hash);
  process.env.LLM_BASE_URL = `${b.url}/v1`;
  await installUsageFixtureForModel("default", db);
  const second = await request();
  await markReceiptsCompleted([second.receiptId]);
  const secondProof = await readPolicyResponse({ receiptId: second.receiptId, attemptId: second.attemptId! });
  assert.ok(secondProof?.configuration_hash);
  assert.notEqual(firstProof.receiptId, secondProof.receiptId);
  assert.notEqual(firstProof.configuration_hash, secondProof.configuration_hash);
  const ea = policyModelEvidence(firstProof),
    eb = policyModelEvidence(secondProof),
    ka = policyModelQualificationKey(ea)!,
    kb = policyModelQualificationKey(eb)!;
  assert.equal(ea.requestedModel, eb.requestedModel);
  assert.equal(ea.reportedModel, eb.reportedModel);
  assert.notEqual(ka, kb);
  assert.equal(ea.connectionId, null);
  assert.equal(ea.connectionRevision, null);
  const qualification = { sourceId, language: "en", fulltextRecipe: "synthetic1", interpretationRecipe: policyInterpretationQualityRecipe("synthetic1") };
  const review = {
    sourceIds: [sourceId],
    languages: ["en"],
    fulltextRecipe: qualification.fulltextRecipe,
    interpretationRecipe: qualification.interpretationRecipe,
    models: [ka],
    reviewedBy: "owner",
    reviewEvidence: "SYNTHETIC isolated test only, no actual Owner approval",
    evaluationHash: sha256("synthetic evaluation"),
    reviewedAt: new Date(Date.now() - 1000).toISOString(),
    validUntil: new Date(Date.now() + 3600000).toISOString(),
  };
  const id = await installPolicyQualityRelease(review);
  assert.equal((await matchingPolicyQuality({ ...qualification, models: [ka] }))?.id, id);
  assert.equal(await matchingPolicyQuality({ ...qualification, models: [kb] }), null);
  assert.equal(await matchingPolicyQuality({ ...qualification, models: [ea.reportedModel!] }), null);
  await assert.rejects(installPolicyQualityRelease({ ...review, models: [ea.reportedModel] }));
  await db`UPDATE receipts SET request=request||${db.json({ configuration_hash: secondProof.configuration_hash, connection_id: "forged-request-only" })} WHERE id=${first.receiptId}`;
  const reread = await readPolicyResponse({ receiptId: first.receiptId, attemptId: first.attemptId! });
  assert.equal(policyModelQualificationKey(policyModelEvidence(reread!)), ka);
  const registered = {
    ...ea,
    service: "registered:11111111-1111-4111-8111-111111111111",
    connectionId: "11111111-1111-4111-8111-111111111111",
    connectionRevision: 1,
  };
  assert.ok(policyModelQualificationKey(registered));
  assert.notEqual(policyModelQualificationKey(registered), ka);
  assert.equal(policyModelQualificationKey({ ...registered, connectionId: "22222222-2222-4222-8222-222222222222" }), null);
  assert.equal(policyModelQualificationKey({ ...registered, connectionRevision: null }), null);
  assert.equal(policyModelQualificationKey({ ...ea, connectionId: registered.connectionId, connectionRevision: 1 }), null);
  const before = a.hits() + b.hits();
  await db`DELETE FROM ai.model_attempt_snapshots WHERE attempt_id=${first.attemptId!}::bigint`;
  const legacy = await readPolicyResponse({ receiptId: first.receiptId, attemptId: first.attemptId! });
  assert.equal(legacy?.configuration_hash, null);
  assert.equal(policyModelQualification([policyModelEvidence(legacy!)]).modelEvidenceComplete, false);
  assert.equal(a.hits() + b.hits(), before);
});

test("qualification-only fields preserve the pre-existing vision content hash and never make missing evidence complete", () => {
  const base = { receiptId: 1, attemptId: "11", service: "llm", requestedModel: "same", reportedModel: "same" };
  const old = { status: "extracted", resources: [], modelEvidence: [base], publication_authorized: false, semantic_verified: false };
  const current = { ...old, modelEvidence: [{ ...base, configurationHash: sha256("actual snapshot"), connectionId: null, connectionRevision: null }] };
  assert.equal(policyVisionContentHash(current), sha256(stableJson(old)));
  assert.equal(
    policyVisionContentHash({ ...current, modelEvidence: [{ ...current.modelEvidence[0]!, configurationHash: sha256("other snapshot") }] }),
    sha256(stableJson(old)),
  );
  assert.notDeepEqual(
    policyModelQualification(current.modelEvidence).models,
    policyModelQualification([{ ...current.modelEvidence[0]!, configurationHash: sha256("other snapshot") }]).models,
  );
  assert.equal(policyModelQualification([]).modelEvidenceComplete, false);
  assert.equal(policyModelQualification([{ ...current.modelEvidence[0]!, reportedModel: null }]).modelEvidenceComplete, false);
});
