import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import {
  DeliveryIssue,
  ReceiptIssue,
  ReceiptObservedVersion,
  ReceiptReconciliationResponse,
  ReceiptReleaseRequest,
  ReceiptReleaseResponse,
  ReceiptVersionInput,
  type ReceiptVersionFields,
  routes,
  schemas,
} from "@amp/contracts/http/private";
import { receiptObservedVersion } from "@amp/backend/admin/runs";

const fixture: {
  vectors: Array<ReceiptVersionFields & { id: string; preimage: string; expectedVersion: string }>;
  invalidBodies: Array<{ name: string; body: unknown }>;
} = JSON.parse(readFileSync(new URL("./fixtures/receipt-observation.json", import.meta.url), "utf8"));
const first = fixture.vectors[0]!;
const inputOf = ({ receiptId, attempts, updatedAtUtc }: ReceiptVersionFields) => ({ receiptId, attempts, updatedAtUtc });

test("receipt versions preserve exact microseconds and decimal IDs without any database setup", () => {
  const versions = fixture.vectors.map((vector) => {
    const input = inputOf(vector);
    const version = receiptObservedVersion(input);
    assert.equal(version, vector.expectedVersion, vector.id);
    assert.equal(ReceiptObservedVersion.parse(version), version);
    assert.deepEqual(input, inputOf(vector), "the pure helper does not normalize/mutate its inputs");
    return version;
  });
  assert.equal(new Set(versions).size, fixture.vectors.length);
  // Demonstrate the lossy conversions the helper must never use, not conversions used by the helper.
  assert.equal(new Date(first.updatedAtUtc).getTime(), new Date(fixture.vectors[1]!.updatedAtUtc).getTime());
  assert.equal(Number(fixture.vectors[4]!.receiptId), Number(fixture.vectors[5]!.receiptId));
});

test("noncanonical observation input fails closed instead of losing precision or guessing", () => {
  const valid = inputOf(first);
  for (const receiptId of ["0", "042", "-42", "42\n", " 42", "42.0", 42]) {
    assert.equal(ReceiptVersionInput.safeParse({ ...valid, receiptId }).success, false, String(receiptId));
  }
  for (const attempts of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.equal(ReceiptVersionInput.safeParse({ ...valid, attempts }).success, false, String(attempts));
  }
  for (const updatedAtUtc of [
    "2026-10-04T16:00:16.765Z",
    "2026-10-04T16:00:16.765275Z\n",
    "2026-10-04T16:00:16.765275+00:00",
    "2026-02-29T16:00:16.765275Z",
    new Date(first.updatedAtUtc),
    Date.parse(first.updatedAtUtc),
  ]) {
    const invalid = { ...valid, updatedAtUtc };
    assert.equal(ReceiptVersionInput.safeParse(invalid).success, false);
    assert.throws(() => receiptObservedVersion(invalid as ReceiptVersionFields), z.ZodError);
  }
  assert.equal(ReceiptVersionInput.safeParse({ ...valid, updatedAtUtc: "2024-02-29T00:00:00.000000Z" }).success, true);
});

test("release wire requires the original version and keeps billed-true a semantic conflict", () => {
  for (const { name, body } of fixture.invalidBodies) assert.equal(ReceiptReleaseRequest.safeParse(body).success, false, name);
  const body = { billed: false, note: "  provider confirms attempt1 was not billed  ", version: first.expectedVersion };
  assert.deepEqual(ReceiptReleaseRequest.parse(body), { ...body, note: body.note.trim() });
  assert.equal(ReceiptReleaseRequest.safeParse({ ...body, billed: true }).success, true, "the guarded handler must return409, not a schema400");
  const response = { id: 42, status: "failed", subject: null, purpose: "fixture", requeued: false };
  assert.deepEqual(ReceiptReleaseResponse.parse(response), response);
  assert.equal(ReceiptReleaseResponse.safeParse({ ...response, status: "unknown" }).success, false);
});

test("reconciliation validates its wire subset without stripping existing private diagnostics", () => {
  const issue = {
    id: 42,
    status: "unknown",
    service: "fixture",
    model: null,
    purpose: "fixture",
    subject: null,
    error: null,
    attempts: 1,
    updated_at: "2026-10-04T16:00:16.765Z",
    version: first.expectedVersion,
    created_at: "2026-10-04T16:00:00.000Z",
  };
  const delivery = { id: 7, target_key: "fixture", status: "unknown", subject_kind: "item", subject_id: "example", updated_at: issue.updated_at, attempts: 2 };
  const envelope = { receipts: { counts: { unknown: 1 }, issues: [issue] }, deliveries: [delivery], processes: [{ role: "worker" }] };
  assert.deepEqual(ReceiptReconciliationResponse.parse(envelope), envelope);
  const { version: _, ...missing } = issue;
  assert.equal(ReceiptIssue.safeParse(missing).success, false);
  assert.equal(ReceiptIssue.safeParse({ ...issue, updated_at: new Date(issue.updated_at) }).success, false, "schema describes JSON wire dates");
  assert.equal(DeliveryIssue.safeParse({ ...delivery, updated_at: "not-a-date" }).success, false);
  assert.equal(ReceiptReconciliationResponse.safeParse({ ...envelope, receipts: { counts: { unknown: -1 }, issues: [issue] } }).success, false);
});

test("receipt schemas stay in explicit private registration without global leakage", () => {
  assert.equal(schemas.ReceiptObservedVersion, ReceiptObservedVersion);
  assert.equal(schemas.ReceiptReconciliationResponse, ReceiptReconciliationResponse);
  assert.deepEqual(Object.keys(routes), [
    "usageProtection",
    "changeUsageProtection",
    "changeUsagePrice",
    "recoverUsageBreaker",
    "usageMonthlyList",
    "usageMonthlyDetail",
    "modelRegistry",
    "createModelConnection",
    "updateModelConnection",
    "disableModelConnection",
    "probeModelConnection",
    "modelConnectionProbe",
    "assignRegisteredModel",
    "laneControls",
    "laneControlAction",
    "createSource",
    "sourceDetail",
    "loginOptions",
    "receiptReview",
    "releaseReceipt",
  ]);
  for (const schema of [ReceiptObservedVersion, ReceiptReleaseRequest, ReceiptReleaseResponse, ReceiptIssue, ReceiptReconciliationResponse]) {
    assert.equal(z.globalRegistry.has(schema), false);
  }
  const privateRegistry = z.registry<{ id: string }>();
  privateRegistry.add(ReceiptReleaseRequest, { id: "ReceiptReleaseRequest" });
  assert.equal(privateRegistry.get(ReceiptReleaseRequest)?.id, "ReceiptReleaseRequest");
  assert.equal(z.globalRegistry.has(ReceiptReleaseRequest), false);
});
