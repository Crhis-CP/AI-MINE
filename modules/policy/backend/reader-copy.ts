import type { Policy } from "@amp/contracts/http/public";

/** Exact legacy system notices only. Legal text and custom notes are never searched or rewritten. */
const LEGACY_NOTICES = new Map([
  ["原件或处理容量超限，完整正文尚未取得", "完整正文暂不可用，可先查看官方原文。"],
  ["处理回执尚未核清，完整解读暂不可用", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["处理服务暂时不可用，将自动复查", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["处理结果尚待回执确认，将自动复查", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["处理结果未通过完整性核验", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["原文与解读一致性核验未通过", "完整解读暂不可用，可先查看基本事实和官方原文。"],
  ["原件取得配置尚未完成", "完整原文暂未提供，可先查看官方原文。"],
  ["附件目录尚未闭合", "附件清单尚未完整。"],
]);

export const readerProcessingNotice = (notice: string) => LEGACY_NOTICES.get(notice) ?? notice;

export function readerPolicyGaps(policy: Pick<Policy, "gaps" | "attachment_inventory">): string[] {
  return policy.gaps.map((gap) => {
    const attachment = policy.attachment_inventory.find((a) => a.decisive && a.status === "blocked_capacity" && gap === `决定性附件容量受阻：${a.title}`);
    return attachment ? `决定性附件尚未取得：${attachment.title}` : readerProcessingNotice(gap);
  });
}

export const POLICY_COVERAGE_NOTE = "本报告引用当前可公开的文书版本；资料覆盖可能不完整，未收录不代表没有新法规。";
const LEGACY_COVERAGE =
  /^本报告引用当前仍可公开的固定文书版本；未取得完整检查回执不代表没有新法规。(?:另有(\d+)个版本缺少首次发现依据，未推测归期。)?(另有\d+个已登记来源尚未归入既定法域，未猜测归属。)?$/;

export function readerCoverageNote(note: string): string {
  const legacy = LEGACY_COVERAGE.exec(note);
  if (!legacy) return note;
  return POLICY_COVERAGE_NOTE + (legacy[1] ? `另有${legacy[1]}份文书暂无法确定所属刊期。` : "") + (legacy[2] ? "部分来源的所属国家或地区尚未确认。" : "");
}
