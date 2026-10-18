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
