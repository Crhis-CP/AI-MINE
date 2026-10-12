import assert from "node:assert/strict";
import { test } from "node:test";
import { TimeAssertion, normalizeSourceTime } from "@amp/contracts/time-assertion";
import { WithdrawalActionRequest, WithdrawalTarget, SourceArchiveRequest } from "@amp/contracts/http/private";
import { RSS_CACHE_CONTROL } from "@amp/contracts/http-policy";

test("stored former site-public label is canonicalized without changing its recorded time facts", () => {
  const time = normalizeSourceTime(
    {
      meaning: "site_public",
      raw: "2026-10-12T00:00:00Z",
      local_date: "2026-10-12",
      local_time: "00:00:00",
      timezone: "UTC",
      utc: "2026-10-12T00:00:00Z",
      precision: "second",
      basis: "synthetic publication observation",
      condition_text: null,
    },
    { instantBasis: "explicit", timezoneEvidence: "Synthetic UTC clock" },
  );
  const old = { ...time, meaning_label: "本站收录", label: time.label.replace("本站公开于 ", "本站收录于 ") };
  assert.deepEqual(TimeAssertion.parse(old), time);
  assert.equal(time.meaning_label, "本站公开");
  assert.equal(TimeAssertion.safeParse({ ...old, meaning_label: "来源发布" }).success, false);
  assert.equal(TimeAssertion.safeParse({ ...old, beijing_date: "2026-10-11" }).success, false);
});

test("withdrawal contracts distinguish lanes, restoration holds and mandatory archive confirmation", () => {
  const target = { type: "report", kind: "weekly", key: "2026-W40" };
  assert.equal(WithdrawalTarget.parse(target).type, "report");
  assert.equal(WithdrawalTarget.safeParse({ ...target, lane: "policy", kind: "daily" }).success, false);
  const request = { target, reason: "Synthetic correction", expectedSnapshotHash: "a".repeat(64) };
  assert.equal(WithdrawalActionRequest.safeParse({ ...request, action: "restore" }).success, false);
  assert.equal(WithdrawalActionRequest.safeParse({ ...request, action: "restore", withdrawalId: 1 }).success, true);
  assert.equal(WithdrawalActionRequest.safeParse({ ...request, action: "withdraw", withdrawalId: 1 }).success, false);
  assert.equal(SourceArchiveRequest.safeParse({ version: "2026-10-12T00:00:00Z", reason: "Synthetic archive", high_risk_confirmed: false }).success, false);
  assert.equal(RSS_CACHE_CONTROL, "public, max-age=0, s-maxage=0, must-revalidate");
});
