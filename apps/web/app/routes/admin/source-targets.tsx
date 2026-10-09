import { useState } from "react";
import { SourceCoverage, type CoverageData } from "../../features/admin/SourceCoverage";
import { useAdminAction, useAdminMe } from "../../features/admin/action";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import { SITE } from "@amp/industry/site";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/source-targets";
import { adminGet } from "../../lib/admin.server";
import { apiBaseFor } from "../../../api-target";
import { AdminPage, Input, Pager, Select, Button } from "../../features/admin/ui";
import { SourceTargets } from "../../features/admin/SourceTargets";
import type { SourceTargetsData } from "../../features/admin/SourceTargets";
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url),
    query = Object.fromEntries(["q", "country", "state", "page"].flatMap((key) => (url.searchParams.get(key) ? [[key, url.searchParams.get(key)!]] : [])));
  const path = "/api/admin/source-targets",
    client = createPrivateClient({ baseUrl: apiBaseFor(path) });
  const targets = privateSchemas.SourceTargetsResponse.parse(
    await adminGet<SourceTargetsData>(request, `${path}?${new URLSearchParams(query)}`, (_url, init) =>
      client.GET(path, {
        params: {
          query: { ...query, page: Number(query.page ?? 1), state: query.state as "unmatched" | "configured" | "observed" | "needs_address" | undefined },
        },
        headers: init.headers,
        signal: init.signal,
      }),
    ),
  );
  let coverage: CoverageData | null = null;
  try {
    const path = "/api/admin/source-coverage";
    coverage = privateSchemas.SourceCoverage.parse(
      await adminGet(request, path, (_url, init) => client.GET(path, { headers: init.headers, signal: init.signal })),
    );
  } catch (error) {
    if (error instanceof Response && error.status === 302) throw error;
  }
  return { ...targets, matrixCoverage: coverage };
}
export const meta: Route.MetaFunction = () => [{ title: `原表对账 · ${SITE.name} 后台` }];
export default function SourceTargetPage({ loaderData }: Route.ComponentProps) {
  const me = useAdminMe(),
    { run, pending } = useAdminAction();
  const [view, setView] = useState<"targets" | "coverage">("targets");
  const exportTargets = async () => {
    const client = createPrivateClient({ baseUrl: window.location.origin });
    const result = await run(
      "POST",
      "/api/admin/source-targets/export",
      {},
      {
        revalidate: false,
        send: (_url, init) => client.POST("/api/admin/source-targets/export", { headers: init.headers, signal: init.signal, body: {} }),
        parse: privateSchemas.SourceTargetExport.parse,
      },
    );
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = result.filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const [search] = useSearchParams(),
    navigate = useNavigate();
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    value ? next.set(key, value) : next.delete(key);
    next.delete("page");
    navigate(`?${next}`, { preventScrollReset: true });
  };
  return (
    <AdminPage
      title="原始信源表对账"
      subtitle="原表身份保持不变，当前进度来自新系统记录；登记、抓取、正文和发布分别呈现。"
      actions={
        <div className="flex items-center gap-4">
          <Link to="/admin/sources" className="text-[13px] text-accent">
            返回已登记信源
          </Link>
          {me.owner && (
            <Button size="sm" busy={pending === "POST /api/admin/source-targets/export"} onClick={exportTargets}>
              导出完整对账表
            </Button>
          )}
        </div>
      }
    >
      <div role="group" aria-label="对账视图" className="mb-5 flex gap-2">
        <Button tone={view === "targets" ? "primary" : "ghost"} aria-pressed={view === "targets"} onClick={() => setView("targets")}>
          原表明细
        </Button>
        <Button tone={view === "coverage" ? "primary" : "ghost"} aria-pressed={view === "coverage"} onClick={() => setView("coverage")}>
          覆盖与缺口
        </Button>
      </div>
      {view === "coverage" ? (
        <SourceCoverage data={loaderData.matrixCoverage} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-3">
            <Form method="get" className="min-w-[200px] flex-1" preventScrollReset>
              {["country", "state"].map((key) => search.get(key) && <input key={key} type="hidden" name={key} value={search.get(key)!} />)}
              <Input name="q" aria-label="搜索原表目标" placeholder="机构、地区、主题或原表记录号" defaultValue={search.get("q") ?? ""} />
            </Form>
            <Select aria-label="国家筛选" className="!w-auto" value={search.get("country") ?? ""} onChange={(e) => change("country", e.target.value)}>
              <option value="">全部国家</option>
              {loaderData.countries.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select aria-label="对账状态筛选" className="!w-auto" value={search.get("state") ?? ""} onChange={(e) => change("state", e.target.value)}>
              <option value="">全部状态</option>
              <option value="unmatched">尚无匹配配置</option>
              <option value="configured">已匹配配置</option>
              <option value="observed">已有新系统记录</option>
              <option value="needs_address">地址待核</option>
            </Select>
          </div>
          <SourceTargets data={loaderData} />
          <Form method="get" className="mt-4 flex items-center gap-2 text-[12px]" preventScrollReset>
            {["q", "country", "state"].map((key) => search.get(key) && <input key={key} type="hidden" name={key} value={search.get(key)!} />)}
            <label htmlFor="target-page">跳到页码</label>
            <Input
              id="target-page"
              name="page"
              type="number"
              min={1}
              max={Math.max(1, Math.ceil(loaderData.total / 50))}
              defaultValue={loaderData.page}
              className="!w-20"
            />
            <Button type="submit" size="sm">
              跳转
            </Button>
          </Form>
          <p className="mt-4 text-[12px] text-ink-3">
            当前筛选共{loaderData.total}个目标，第{loaderData.page} / {Math.max(1, Math.ceil(loaderData.total / 50))}页。
          </p>
          <Pager page={loaderData.page} hasMore={loaderData.page * 50 < loaderData.total} />
        </>
      )}
    </AdminPage>
  );
}
