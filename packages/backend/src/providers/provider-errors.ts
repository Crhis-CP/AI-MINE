/** Provider refusal and availability are distinct from whether its bill is already known. */
function rejectionDetail(body: string): { code: string; message: string } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { code: "", message: body };
  }
  if (!data || typeof data !== "object") return { code: "", message: body };
  const root = data as Record<string, unknown>;
  const error = root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root;
  return {
    code: typeof error.code === "string" || typeof error.code === "number" ? String(error.code) : typeof error.type === "string" ? error.type : "",
    message: typeof error.message === "string" ? error.message : typeof root.error === "string" ? root.error : body,
  };
}

/**
 * Whether a provider's refusal, as recorded on an article or a receipt (“deepseek HTTP 402: {...Insufficient
 * Balance...}”), says the account is out of money or over its paid limit (TASK-0630). Such a refusal is not the
 * article's fault and ends when the Owner tops up: work waits and goes on by itself, it is never marked failed.
 * A wrong key or a banned account (401, 403) is not this: topping up does not cure it.
 */
const ACCOUNT_OUT =
  /\bHTTP 402\b|\binsufficient (?:account |credit )?balance\b|\b(?:credit )?balance (?:is )?(?:exhausted|insufficient)\b|账户.*欠费|余额不足|credit_balance_exhausted|CreditLimitExceeded|PrepaidBillOverdue|PostpaidBillOverdue|_spend_limit_exceeded|organization_usage_limit_exceeded/i;
export function accountOutOfMoney(message: string | null | undefined): boolean {
  return !!message && ACCOUNT_OUT.test(message);
}
/** The same test for SQL (operations and the safety net read stored messages). Keep in step with ACCOUNT_OUT. */
export const ACCOUNT_OUT_SQL =
  "(HTTP 402\\M|insufficient (account |credit )?balance|balance (is )?(exhausted|insufficient)|账户.*欠费|余额不足|credit_balance_exhausted|CreditLimitExceeded|PrepaidBillOverdue|PostpaidBillOverdue|_spend_limit_exceeded|organization_usage_limit_exceeded)";

export function providerRejection(service: string, status: number, body: string) {
  const { code, message } = rejectionDetail(body);
  const accountLimit =
    [
      "GoUsageLimitError",
      "FreeUsageLimitError",
      "CreditLimitExceeded",
      "credit_balance_exhausted",
      "organization_usage_limit_exceeded",
      "organization_spend_limit_exceeded",
      "project_spend_limit_exceeded",
    ].includes(code) ||
    (service === "zhipu" && ["1113", "1308", "1309", "1310", "1311", "1314", "1315", "1316", "1317", "1318", "1319", "1320", "1321"].includes(code)) ||
    (service === "dashscope" &&
      (["CommodityNotPurchased", "PrepaidBillOverdue", "PostpaidBillOverdue", "BudgetLimitExceeded"].includes(code) ||
        (["Throttling.AllocationQuota", "insufficient_quota"].includes(code) && message.trim() === "Free allocated quota exceeded."))) ||
    /\binsufficient (?:account |credit )?balance\b|\b(?:credit )?balance (?:is )?(?:exhausted|insufficient)\b|账户.*欠费|余额不足/i.test(message);
  const retryable = status >= 500 || (status === 429 && !accountLimit);
  const detail = code ? JSON.stringify({ code, message: message.slice(0, 500) }) : body.slice(0, 500);
  return {
    message: `${service} HTTP ${status}: ${detail}`,
    retryable,
    failureKind: retryable ? ("provider_outage" as const) : ("provider_refused" as const),
  };
}
