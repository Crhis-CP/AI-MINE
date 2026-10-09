import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { PolicyCard } from "@amp/contracts/http/public";
import { closeDb, dbOf } from "@amp/backend/db";
import {
  latestClosedPolicyPeriods,
  planPolicyReport,
  policyReportPeriod,
  type PublicPolicyReportVersion,
} from "../packages/backend/src/publication/policy-report-plan.ts";
import { policyReportsToRecheck, savePolicyReport } from "../packages/backend/src/publication/policy-report-store.ts";
import { policySourceCoverage } from "../packages/backend/src/sources/policy-coverage.ts";
import { setPolicyPublicationPaused } from "../packages/backend/src/publication/policies-publish.ts";
import { reconcilePolicyReportPeriods } from "../packages/backend/src/publication/policy-report-job.ts";

const sql = dbOf("publication");
after(closeDb);
const full = JSON.parse(readFileSync(new URL("./fixtures/policy-public/basic-facts.json", import.meta.url), "utf8"));
const base = PolicyCard.parse(Object.fromEntries(Object.keys(PolicyCard.shape).map((key) => [key, full[key]])));
const issuer = { name: "合成报告编制者", url: "https://example.invalid" };
const now = new Date("2026-10-12T02:00:00Z");
function edition(
  id: string,
  day: string | null,
  discoveredAt: string | null,
  releasedAt = "2026-10-10T00:00:00Z",
  extra: Partial<PublicPolicyReportVersion> = {},
): PublicPolicyReportVersion {
  const policy = structuredClone(base);
  policy.id = id;
  if (day)
    policy.published_time = {
      ...policy.published_time,
      precision: "date",
      local_date: day,
      local_time: null,
      timezone: null,
      utc: null,
      beijing_date: day,
      raw: day,
      label: day,
    };
  policy.sort_time = day ? policy.published_time : null;
  policy.sort_kind = day ? "published" : null;
  return {
    editionId: id,
    originalRevisionKey: id,
    policy,
    releasedAt,
    discoveredAt,
    sourceLanguage: "es",
    preferredSourceLanguage: "es",
    attributions: [issuer],
    versions: [
      {
        policy_version_id: "version-1",
        expression_id: "expression-1",
        document_revision_id: "revision-1",
        language: "es",
        instrument_number: null,
        kind: "original",
        current: true,
        first_public_at: policy.first_public_at,
        published_time: policy.published_time,
        original_version: "原件",
        checked_at: null,
      },
    ],
    ...extra,
  };
}

test("natural periods are Beijing right-open weeks/months, including year transitions", () => {
  assert.deepEqual(policyReportPeriod("weekly", "2026-W41"), {
    startDay: "2026-10-05",
    endDay: "2026-10-12",
    start: "2026-10-04T16:00:00.000Z",
    end: "2026-10-11T16:00:00.000Z",
  });
  assert.equal(policyReportPeriod("monthly", "2026-02").endDay, "2026-03-01");
  assert.deepEqual(latestClosedPolicyPeriods(new Date("2027-01-04T00:00:00Z")), { weekly: "2026-W53", monthly: "2026-12" });
  assert.throws(() => planPolicyReport("weekly", "2026-W42", [], [], issuer, now), /still open/);
});

test("period membership preserves versions, stable language, backfill, unknown dates and late interpretation distinctly", () => {
  const rows = [
    edition("a-old", "2026-10-06", "2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z"),
    edition("a-new", "2026-10-06", "2026-10-06T00:00:00Z"),
    edition("a-version2", "2026-10-09", "2026-10-09T00:00:00Z"),
    edition("a-en", "2026-10-09", "2026-10-09T00:00:00Z", undefined, { sourceLanguage: "en" }),
    edition("backfill", "2026-09-01", "2026-10-07T00:00:00Z"),
    edition("unknown", null, "2026-10-09T00:00:00Z"),
    edition("interpretation", "2026-09-01", "2026-09-02T00:00:00Z"),
    edition("found-too-late", "2026-10-06", "2026-10-11T17:00:00Z", "2026-10-12T00:00:00Z"),
    edition("discovery-unproved", "2026-10-06", null),
    edition("published-after-cutoff", "2026-10-06", "2026-10-07T00:00:00Z", "2026-10-12T00:00:00Z"),
  ];
  for (const row of rows.slice(0, 4)) row.policy.id = "same-instrument";
  rows[0]!.originalRevisionKey = "original-1";
  rows[1]!.originalRevisionKey = "original-1";
  const plan = planPolicyReport("weekly", "2026-W41", rows, [], issuer, now),
    members = new Map(plan.members.map((m) => [m.editionId, m]));
  assert.deepEqual([...members.keys()].sort(), ["a-new", "a-version2", "backfill", "unknown", "interpretation", "published-after-cutoff"].sort());
  assert.equal(members.get("a-new")!.label, "period_change");
  assert.equal(members.get("backfill")!.label, "backfill");
  assert.equal(members.get("unknown")!.label, "source_date_unknown");
  assert.equal(members.get("interpretation")!.label, "interpretation_update");
  assert.equal(members.get("published-after-cutoff")!.availableByCutoff, false);
  assert.equal(plan.card.item_count, 5);
  assert.match(plan.card.coverage_note, /缺少首次发现依据/);
  assert.equal(plan.contentHash, planPolicyReport("weekly", "2026-W41", [...rows].reverse(), [], issuer, new Date(now.getTime() + 3600_000)).contentHash);
});

test("report revisions are idempotent under concurrent rechecks and preserve fixed members after a correction", async () => {
  const one = edition("report-member-1", "2026-10-06", "2026-10-06T00:00:00Z");
  const first = planPolicyReport("weekly", "2026-W41", [one], [], issuer, now);
  const pair = await Promise.all([savePolicyReport(first), savePolicyReport(first)]);
  assert.equal(pair.filter((r) => r.created).length, 1);
  assert.equal(pair[0]!.id, pair[1]!.id);
  const revised = await savePolicyReport(planPolicyReport("weekly", "2026-W41", [], [], issuer, now));
  assert.equal(revised.revision, 2);
  const versions =
    await sql`SELECT revision,previous_revision,card,change FROM publication.policy_report_revisions WHERE report_id=${revised.id} ORDER BY revision`;
  assert.equal(versions.length, 2);
  assert.equal(versions[1]!.previous_revision, 1);
  assert.equal(versions[1]!.change.removed, 1);
  const members = await sql`SELECT report_revision,edition_id FROM publication.policy_report_members WHERE report_id=${revised.id}`;
  assert.deepEqual(
    members.map((m) => [m.report_revision, m.edition_id]),
    [[1, "report-member-1"]],
  );
  assert.equal((await policyReportsToRecheck(1)).length, 1);
  await assert.rejects(policyReportsToRecheck(0));
});

test("coverage counts real registrations but never substitutes successful HTTP for complete catalogue receipts", async () => {
  await sql`INSERT INTO sources(id,name,kind,config,lane,created_at) VALUES
    ('policy-cn-001','合成官方来源','rss','{}','policy','2026-09-01Z'),
    ('report-news-fixture','资讯来源','rss','{}','news','2026-09-01Z')`;
  await sql`INSERT INTO fetch_runs(source_id,status,started_at,finished_at,error) VALUES
    ('policy-cn-001','ok','2026-10-06T00:00:00Z','2026-10-06T00:00:01Z',NULL),
    ('policy-cn-001','failed','2026-10-07T00:00:00Z','2026-10-07T00:00:01Z','HTTP 403 private_token=do-not-publish'),
    ('report-news-fixture','failed','2026-10-07T00:00:00Z','2026-10-07T00:00:01Z','timeout')`;
  const { rows } = await policySourceCoverage("2026-10-04T16:00:00Z", "2026-10-11T16:00:00Z"),
    china = rows.find((r) => r.jurisdiction.code === "CN")!;
  assert.equal(rows.length, 36);
  assert.equal(china.registered_source_count, 1);
  assert.equal(china.complete_receipt_count, 0);
  assert.equal(china.missing_receipt_count, 1);
  assert.equal(china.failures.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /do-not-publish|private_token|资讯来源/);
});

test("publication pause prevents new reports and members but permits withdrawal corrections; hourly work waits for Beijing 08:00", async () => {
  await sql`TRUNCATE publication.policy_report_members,publication.policy_report_revisions,publication.policy_reports`;
  const one = edition("paused-member-1", "2026-10-06", "2026-10-06T00:00:00Z"),
    two = edition("paused-member-2", "2026-10-07", "2026-10-07T00:00:00Z");
  let version = await setPolicyPublicationPaused({ expectedVersion: 1, paused: true, actor: "test", reason: "Synthetic publication pause" });
  const first = await savePolicyReport(planPolicyReport("weekly", "2026-W41", [one], [], issuer, now));
  assert.equal(first.paused, true);
  assert.equal((await sql`SELECT id FROM publication.policy_reports`).length, 0);
  version = await setPolicyPublicationPaused({ expectedVersion: version, paused: false, actor: "test", reason: "Synthetic resume" });
  const initial = await savePolicyReport(planPolicyReport("weekly", "2026-W41", [one], [], issuer, now));
  version = await setPolicyPublicationPaused({ expectedVersion: version, paused: true, actor: "test", reason: "Synthetic pause again" });
  const adding = await savePolicyReport(planPolicyReport("weekly", "2026-W41", [one, two], [], issuer, now));
  assert.equal(adding.paused, true);
  assert.equal(adding.revision, initial.revision);
  const removing = await savePolicyReport(planPolicyReport("weekly", "2026-W41", [], [], issuer, now));
  assert.equal(removing.paused, false);
  assert.equal(removing.revision, initial.revision + 1);
  await setPolicyPublicationPaused({ expectedVersion: version, paused: false, actor: "test", reason: "Synthetic final resume" });
  await sql`TRUNCATE publication.policy_report_members,publication.policy_report_revisions,publication.policy_reports`;
  const before = await reconcilePolicyReportPeriods(async () => [one], new Date("2026-10-11T23:59:59Z"));
  assert.equal(
    before.some((r) => r.kind === "weekly" && r.periodKey === "2026-W41"),
    false,
  );
  const onTime = await reconcilePolicyReportPeriods(async () => [one], new Date("2026-10-12T00:00:00Z"));
  assert.equal(onTime.find((r) => r.kind === "weekly" && r.periodKey === "2026-W41")?.created, true);
  const again = await reconcilePolicyReportPeriods(async () => [one], new Date("2026-10-12T01:00:00Z"));
  assert.ok(again.every((r) => !r.created));
});
