// One-off backfill for news that was judged on a title alone before the 20-character rule (TASK-0598, Owner 2026-11-08,
// DEC-78补充·只抓到标题的资讯：重抓正文，抓不到不上). Each candidate enters the ordinary body read schedule
// (packages/backend/src/jobs/body-reread.ts): the worker's sweep reads its page again at low priority with the usual
// host pacing, robots and source permission checks; an article that now has 20 characters or more goes through the
// normal analysis, which waits for the provider's off-peak hours behind live work; the rest are read again at +3 h and
// +12 h and then fail as “正文读取失败”, listed per source on the runs page. Reading pays for no model call; only the
// analysis of an article that became readable does. Articles a person withdrew or revised are left alone.
//   node scripts/body-reread-backfill.ts                     --dry-run (default): counts per source and the paid estimate
//   node scripts/body-reread-backfill.ts --apply --limit N   schedules at most N candidates; resumable (run it again)
import { closeDb, initializeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { publicArticleIds } from "@amp/backend/publication/publish";
import {
  bodyBackfillCandidates,
  bodyBackfillEstimate,
  recentlyReadableSources,
  scheduleBodyBackfill,
  type BodyBackfillCandidate,
} from "../packages/backend/src/jobs/body-reread.ts";

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : null;
const apply = args.includes("--apply");
const unknown = args.filter((a, i) => !["--dry-run", "--apply", "--limit"].includes(a) && !(limitAt >= 0 && i === limitAt + 1));
if (unknown.length || (apply && args.includes("--dry-run")) || apply !== (limit !== null) || (limit !== null && (!Number.isInteger(limit) || limit < 1))) {
  console.error("usage: body-reread-backfill.ts [--dry-run | --apply --limit N]; nothing written");
  process.exit(2);
}

await initializeDb("worker");
try {
  const perSource = new Map<string, { name: string; n: number }>();
  const chosen: BodyBackfillCandidate[] = [];
  let total = 0,
    visible = 0,
    skipped = 0,
    afterId: string | null = null;
  for (;;) {
    const page = await bodyBackfillCandidates(afterId, 500);
    skipped += page.skipped;
    visible += (await publicArticleIds(page.candidates.map((c) => c.id))).size;
    for (const c of page.candidates) {
      total += 1;
      const entry = perSource.get(c.sourceId) ?? { name: c.sourceName, n: 0 };
      entry.n += 1;
      perSource.set(c.sourceId, entry);
      if (apply && chosen.length < limit!) chosen.push(c);
    }
    if (!page.last) break;
    afterId = page.last;
  }
  const readable = await recentlyReadableSources([...perSource.keys()]);
  const likely = [...perSource].reduce((sum, [id, s]) => sum + (readable.has(id) ? s.n : 0), 0);
  console.log(`只有标题的资讯补读${apply ? "" : "（预演，不写入）"}：候选 ${total} 条，来自 ${perSource.size} 个信源；人工控制或已补读过而跳过 ${skipped} 条`);
  console.log("  条数  近14天读到过正文  信源");
  for (const [id, s] of [...perSource].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])))
    console.log(`${String(s.n).padStart(6)}  ${readable.has(id) ? "是" : "否"}                ${id}  ${s.name}`);
  console.log(`其中读者现在看得到的 ${visible} 条：补读后仍不足 20 字的，下次分析后撤下（只有标题的不上）`);
  for (const line of bodyBackfillEstimate(likely, total)) console.log(line);
  if (apply) {
    let scheduled = 0,
      likelyScheduled = 0,
      first: Date | null = null;
    for (const c of chosen) {
      const due = await scheduleBodyBackfill(c);
      if (!due) continue;
      scheduled += 1;
      if (readable.has(c.sourceId)) likelyScheduled += 1;
      if (!first || due < first) first = due;
    }
    console.log(`已安排 ${scheduled} 条补读（最早 ${first?.toISOString() ?? "—"} 起由服务器每 5 分钟最多读 50 条），剩余候选 ${total - scheduled} 条`);
    console.log(`本批${bodyBackfillEstimate(likelyScheduled, scheduled)[1]!.trim()}`);
  }
} finally {
  await stopBoss();
  await closeDb();
}
