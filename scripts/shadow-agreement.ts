// The event rules in shadow against the live engine (package 2, step 2.4): same-fact agreement, the share that still
// needs the model (the call forecast of a switch), counts per rule, and both engines against people's corrections.
//   node scripts/shadow-agreement.ts [--days 14] [--json]
// Read-only: it reads events.shadow_decisions, the memberships as they are now and the audit log, writes nothing and
// calls no model. What each number means: packages/backend/src/pipeline/events/agreement.ts.
import { parseArgs } from "node:util";
import { closeDb, initializeDb } from "@amp/backend/db";
import { shadowAgreement } from "../packages/backend/src/pipeline/events/agreement.ts";

const { values } = parseArgs({ options: { days: { type: "string", default: "14" }, json: { type: "boolean", default: false } } });
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 45) {
  console.error("usage: shadow-agreement.ts [--days 1..45] [--json]; nothing read");
  process.exit(2);
}
const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

await initializeDb("worker");
try {
  const to = new Date(),
    from = new Date(to.getTime() - days * 86_400_000);
  const a = await shadowAgreement(from, to);
  if (values.json) console.log(JSON.stringify(a, null, 2));
  else {
    const lines = [
      `事件新规则影子对照：${a.from} 至 ${a.to}（规则版本 ${a.ruleset}）`,
      `影子记录 ${a.rows} 条，规则判了 ${a.judged} 篇（不在规则范围的与编辑要求重判前的不算）`,
      `不问模型就判定 ${a.decided} 篇（${percent(a.decided, a.judged)}）；仍需模型 ${a.undecided} 篇（${percent(a.undecided, a.judged)}，即切换后的模型调用预测）`,
      `判为同一件事 ${a.sameFact.rows} 篇，与现在的归组一致 ${a.sameFact.agree} 篇（${percent(a.sameFact.agree, a.sameFact.rows)}）`,
      `成对比较 ${a.pairs.total} 对：规则判同 ${a.pairs.shadowSame}，现网同 ${a.pairs.liveSame}，两边都同 ${a.pairs.both}（准确 ${percent(a.pairs.both, a.pairs.shadowSame)}，召回 ${percent(a.pairs.both, a.pairs.liveSame)}）`,
      `规则判新事件 ${a.newEvent.rows} 篇：现网并入已有事实 ${a.newEvent.liveJoinedFact} 篇，作为新事实并入已有事件 ${a.newEvent.liveJoinedStory} 篇`,
      `现网并入已有事实的 ${a.recallHit.eligible} 篇里，该事实在规则候选中的 ${a.recallHit.hit} 篇（${percent(a.recallHit.hit, a.recallHit.eligible)}）`,
      `模型调用：规则下仍需至多 ${a.calls.wouldCall} 次；这些稿件现网调用过模型的 ${a.calls.liveCalled} 篇`,
      `人工纠正标注 ${a.human.pairs} 对：规则对 ${a.human.shadowRight}、错 ${a.human.shadowWrong}（待定不计）；现网对 ${a.human.liveRight}、错 ${a.human.liveWrong}`,
      "各规则：",
      ...Object.entries(a.byRule)
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([rule, n]) => `  ${rule} ${n}`),
    ];
    console.log(lines.join("\n"));
  }
} finally {
  await closeDb();
}
