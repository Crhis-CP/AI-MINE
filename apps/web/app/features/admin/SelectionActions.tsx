import { apiFetch } from "../../lib/http.ts";
import { useRef } from "react";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import { useAdminAction } from "./action";
export function useSelectionActions() {
  const { run, pending } = useAdminAction(),
    keys = useRef(new Map<string, string>()),
    apiBase = "";
  const execute = async (
    kind: "tool" | "label" | "review" | "holdout" | "audit-draw" | "audit-label",
    input: Record<string, unknown>,
    target?: { datasetId: string; caseId: string } | { articleId: string },
  ) => {
    const stamp = JSON.stringify([kind, input, target]),
      requestId = keys.current.get(stamp) ?? crypto.randomUUID();
    keys.current.set(stamp, requestId);
    const base = { ...input, requestId };
    let result: unknown = null;
    if (kind === "tool") {
      const body = privateSchemas.SelectionToolRequest.parse(base);
      result = await run("POST", "/api/admin/selectbench/control", body, {
        onConflict: () => {},
        success: body.enabled ? "建设期工具已开启" : "建设期工具已关闭",
        send: (_url, init) => apiFetch("/api/admin/selectbench/control", { json: body, headers: init.headers, method: "POST", baseUrl: apiBase }),
        parse: privateSchemas.SelectionToolState.parse,
      });
    }
    if (kind === "label" && target && "datasetId" in target) {
      const body = privateSchemas.SelectionLabelRequest.parse(base);
      result = await run("POST", `/api/admin/selectbench/samples/${encodeURIComponent(target.datasetId)}/${encodeURIComponent(target.caseId)}`, body, {
        onConflict: () => {},
        success: "标注已保存",
        send: (_url, init) =>
          apiFetch("/api/admin/selectbench/samples/{datasetId}/{caseId}", {
            params: { path: target },
            json: body,
            headers: init.headers,
            method: "POST",
            baseUrl: apiBase,
          }),
        parse: privateSchemas.SelectionLabel.parse,
      });
    }
    if (kind === "audit-draw") {
      const body = privateSchemas.PrefilterAuditDrawRequest.parse(base);
      result = await run("POST", "/api/admin/selectbench/prefilter-audit", body, {
        onConflict: () => {},
        success: "已抽出一批",
        parse: privateSchemas.PrefilterAuditView.parse,
      });
    }
    if (kind === "audit-label" && target && "articleId" in target) {
      const body = privateSchemas.PrefilterAuditLabelRequest.parse(base);
      result = await run("POST", `/api/admin/selectbench/prefilter-audit/${encodeURIComponent(target.articleId)}`, body, {
        onConflict: () => {},
        success: "判断已保存",
        parse: privateSchemas.PrefilterAuditLabel.parse,
      });
    }
    if (kind === "review") {
      const body = privateSchemas.SelectionStandardReview.parse(base);
      result = await run("POST", "/api/admin/selectbench/standard-review", body, {
        onConflict: () => {},
        success: "审阅结论已记录",
        send: (_url, init) => apiFetch("/api/admin/selectbench/standard-review", { json: body, headers: init.headers, method: "POST", baseUrl: apiBase }),
        parse: privateSchemas.SelectionRecord.parse,
      });
    }
    if (kind === "holdout") {
      const body = privateSchemas.SelectionHoldoutConfirm.parse(base);
      result = await run("POST", "/api/admin/selectbench/holdout-confirm", body, {
        onConflict: () => {},
        success: "留出集确认已记录",
        send: (_url, init) => apiFetch("/api/admin/selectbench/holdout-confirm", { json: body, headers: init.headers, method: "POST", baseUrl: apiBase }),
        parse: privateSchemas.SelectionRecord.parse,
      });
    }
    if (result) keys.current.delete(stamp);
    return !!result;
  };
  return { execute, pending };
}
