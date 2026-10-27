import { sql } from "@amp/backend/db";
import { readerProcessingNotice } from "../reader-copy.ts";

/** Public wording is selected from status codes; private errors and model/receipt details never enter a DTO. */
export async function policyProcessingNotice(expressionId: string) {
  const [row] = await sql<
    { status: string }[]
  >`SELECT status FROM policy.material_workflows WHERE expression_id=${expressionId} ORDER BY updated_at DESC LIMIT 1`;
  const labels: Record<string, string> = {
    blocked_capacity: "原件或处理容量超限，完整正文尚未取得",
    blocked_unknown: "处理回执尚未核清，完整解读暂不可用",
    provider_unavailable: "处理服务暂时不可用，将自动复查",
    waiting_receipt: "处理结果尚待回执确认，将自动复查",
    invalid_output: "处理结果未通过完整性核验",
    semantic_failed: "原文与解读一致性核验未通过",
    uncertain: "文书相关性尚未确认，仅展示独立基本事实",
    incomplete: "原件、版面或附件尚未完整",
    needs_configuration: "原件取得配置尚未完成",
  };
  return row && labels[row.status] ? readerProcessingNotice(labels[row.status]!) : null;
}
