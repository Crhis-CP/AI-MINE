import type { ComponentType } from "react";
import type { AdminRuns } from "./run-types";
import { Card } from "./ui";

export function ModuleRunPanels({
  parts,
  modules,
}: {
  parts: readonly { name: string; part: ComponentType<{ data: unknown }> }[];
  modules: AdminRuns["modules"];
}) {
  return (
    <>
      {parts.map(({ name, part: Panel }) => {
        const result = modules && Object.hasOwn(modules, name) ? modules[name] : undefined;
        if (!result) return null;
        return result.status === "ready" ? (
          <Panel key={name} data={result.data} />
        ) : (
          <Card key={name} title={name} className="mb-5">
            <p role="status">这部分运行信息暂时无法读取，稍后将随页面刷新重试。</p>
          </Card>
        );
      })}
    </>
  );
}
