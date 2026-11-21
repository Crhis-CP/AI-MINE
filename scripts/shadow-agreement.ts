// The event rules in shadow against the live engine (package 2, step 2.4): same-fact agreement, the share that still
// needs the model (the call forecast of a switch), counts per rule, and both engines against people's corrections.
//   node scripts/shadow-agreement.ts [--days 14] [--mode lexical|vector] [--json]
// Without --mode it reports each recall mode the worker recorded rows in during the window, newest first
// (agreement.ts shadowAgreements), never the mode this shell's environment would pick.
// Read-only: it reads events.shadow_decisions, the memberships as they are now and the audit log, writes nothing and
// calls no model. What each number means: packages/backend/src/pipeline/events/agreement.ts.
import { parseArgs } from "node:util";
import { closeDb, initializeDb } from "@amp/backend/db";
import { shadowAgreement, shadowAgreements, shadowForecastLine } from "../packages/backend/src/pipeline/events/agreement.ts";

const { values } = parseArgs({ options: { days: { type: "string", default: "14" }, mode: { type: "string" }, json: { type: "boolean", default: false } } });
const days = Number(values.days);
const mode = values.mode;
if (!Number.isInteger(days) || days < 1 || days > 45 || (mode !== undefined && mode !== "lexical" && mode !== "vector")) {
  console.error("usage: shadow-agreement.ts [--days 1..45] [--mode lexical|vector] [--json]; nothing read");
  process.exit(2);
}
const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

await initializeDb("worker");
try {
  const to = new Date(),
    from = new Date(to.getTime() - days * 86_400_000);
  const reports = mode ? [await shadowAgreement(from, to, { mode })] : await shadowAgreements(from, to);
  if (values.json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  else
    for (const a of reports) {
      const lines = [
        `事件新规则影子对照：${a.from} 至 ${a.to}（规则版本 ${a.ruleset}）`,
        `影子记录 ${a.rows} 条：规则试判 ${a.judged} 篇，不在规则范围 ${a.outside} 篇（编辑要求重判之前的记录不算）`,
        `不问模型就判定 ${a.decided} 篇（${percent(a.decided, a.judged)}），仍待模型判断 ${a.undecided} 篇（${percent(a.undecided, a.judged)}）`,
        shadowForecastLine(a.calls),
        `判为同一件事 ${a.sameFact.rows} 篇，与现在的归组一致 ${a.sameFact.agree} 篇（${percent(a.sameFact.agree, a.sameFact.rows)}）`,
        `成对比较 ${a.pairs.total} 对：规则判同 ${a.pairs.shadowSame}，现网同 ${a.pairs.liveSame}，两边都同 ${a.pairs.both}（准确 ${percent(a.pairs.both, a.pairs.shadowSame)}，召回 ${percent(a.pairs.both, a.pairs.liveSame)}）`,
        `规则判新事件 ${a.newEvent.rows} 篇：现网并入已有事实 ${a.newEvent.liveJoinedFact} 篇，作为新事实并入已有事件 ${a.newEvent.liveJoinedStory} 篇`,
        `召回命中：现网并入已有事实的 ${a.recallHit.eligible} 篇里，该事实在影子保存的至多 5 个候选中的 ${a.recallHit.hit} 篇（${percent(a.recallHit.hit, a.recallHit.eligible)}；只看这类稿件，精选与背景按影子运行时的状态）`,
        `人工纠正标注 ${a.human.pairs} 对：规则对 ${a.human.shadowRight}、错 ${a.human.shadowWrong}（待定不计）；现网对 ${a.human.liveRight}、错 ${a.human.liveWrong}${a.human.truncated ? "（纠正记录超过读取上限，只用了最新的）" : ""}`,
        `候选窗口读满上限的任务 ${a.windowFull} 个（按队列还保留的已完成任务计）`,
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
