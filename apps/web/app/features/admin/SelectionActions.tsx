import { useRef } from "react";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import { useAdminAction } from "./action";
export function useSelectionActions() {
  const { run, pending } = useAdminAction(),
    keys = useRef(new Map<string, string>()),
    client = createPrivateClient({});
  const execute = async (kind: "tool" | "label" | "review" | "holdout", input: Record<string, unknown>, target?: { datasetId: string; caseId: string }) => {
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
        send: (_url, init) => client.POST("/api/admin/selectbench/control", { body, headers: init.headers }),
        parse: privateSchemas.SelectionToolState.parse,
      });
    }
    if (kind === "label" && target) {
      const body = privateSchemas.SelectionLabelRequest.parse(base);
      result = await run("POST", `/api/admin/selectbench/samples/${encodeURIComponent(target.datasetId)}/${encodeURIComponent(target.caseId)}`, body, {
        onConflict: () => {},
        success: "标注已保存",
        send: (_url, init) => client.POST("/api/admin/selectbench/samples/{datasetId}/{caseId}", { params: { path: target }, body, headers: init.headers }),
        parse: privateSchemas.SelectionLabel.parse,
      });
    }
    if (kind === "review") {
      const body = privateSchemas.SelectionStandardReview.parse(base);
      result = await run("POST", "/api/admin/selectbench/standard-review", body, {
        onConflict: () => {},
        success: "审阅结论已记录",
        send: (_url, init) => client.POST("/api/admin/selectbench/standard-review", { body, headers: init.headers }),
        parse: privateSchemas.SelectionRecord.parse,
      });
    }
    if (kind === "holdout") {
      const body = privateSchemas.SelectionHoldoutConfirm.parse(base);
      result = await run("POST", "/api/admin/selectbench/holdout-confirm", body, {
        onConflict: () => {},
        success: "留出集确认已记录",
        send: (_url, init) => client.POST("/api/admin/selectbench/holdout-confirm", { body, headers: init.headers }),
        parse: privateSchemas.SelectionRecord.parse,
      });
    }
    if (result) keys.current.delete(stamp);
    return !!result;
  };
  return { execute, pending };
}
