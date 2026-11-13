// 法规文书 (TASK-0610): the public policy documents, with the two controls an operator needs on one document:
// take it down (readers see “已下架”) and pause its further publication (what is public stays, nothing new is added).
import { apiFetch } from "@amp/web/extension";
import { useState } from "react";
import { Form, useLoaderData, useSearchParams } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import type { z } from "zod";
import { SITE } from "@amp/industry/site";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import { adminGet } from "@amp/web/admin-extension.server";
import { useAdminAction, useAdminMe } from "@amp/web/admin-action";
import { AdminPage, Badge, Button, Card, Empty, FilterChips, Input, ReasonDialog, Time } from "@amp/web/admin-ui";

type Doc = z.infer<typeof privateSchemas.AdminPolicyDocument>;
type Change = { doc: Doc; field: "withdrawn" | "paused"; value: boolean };

export const meta = () => [{ title: `法规文书 · ${SITE.name} 后台` }];
export async function loader({ request }: LoaderFunctionArgs) {
  const from = new URL(request.url).searchParams,
    query = new URLSearchParams();
  for (const key of ["q", "state"]) if (from.get(key)) query.set(key, from.get(key)!);
  const path = `/api/admin/policies${query.size ? `?${query}` : ""}`;
  return privateSchemas.AdminPolicyList.parse(
    await adminGet(request, path, (url, init) => apiFetch(path, { baseUrl: new URL(url).origin, headers: init.headers, signal: init.signal, method: "GET" })),
  );
}

const WORDS = {
  withdrawn: {
    on: { button: "下架", title: "下架这份法规文书", note: "下架后读者打开它会看到“已下架”，列表、脉络和报告里也不再出现。可以随时恢复。", done: "已下架" },
    off: { button: "恢复公开", title: "恢复公开这份法规文书", note: "恢复后读者可以重新看到它。", done: "已恢复公开" },
  },
  paused: {
    on: { button: "暂停更新", title: "暂停这份文书的后续发布", note: "读者现在看到的内容保留，之后的新版本先不发布。", done: "已暂停更新" },
    off: { button: "恢复更新", title: "恢复这份文书的后续发布", note: "之后的新版本照常发布。", done: "已恢复更新" },
  },
};

export default function AdminPolicies() {
  const { items, total } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const me = useAdminMe();
  const { run, pending } = useAdminAction();
  const [change, setChange] = useState<Change | null>(null);
  const words = change ? WORDS[change.field][change.value ? "on" : "off"] : null;
  return (
    <AdminPage
      title="法规文书"
      subtitle={`${total > items.length ? `显示最近更新的 ${items.length} 份，更早的请用查找` : `共 ${total} 份`}。下架和暂停更新只有 Owner 可以操作，都要写原因。`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterChips
          param="state"
          options={[
            { value: "", label: "全部" },
            { value: "withdrawn", label: "已下架" },
            { value: "paused", label: "已暂停更新" },
          ]}
        />
        <Form method="get" className="flex items-center gap-2">
          {params.get("state") && <input type="hidden" name="state" value={params.get("state")!} />}
          <Input name="q" defaultValue={params.get("q") ?? ""} placeholder="按标题或编号查找" aria-label="按标题或编号查找" />
          <Button type="submit">查找</Button>
        </Form>
      </div>
      {items.length === 0 ? (
        <Empty title="没有符合条件的法规文书">法规线发布文书后会出现在这里。</Empty>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {items.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {doc.title ? (
                      <a
                        className="truncate font-medium text-ink hover:text-accent"
                        href={`/policies/${encodeURIComponent(doc.id)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {doc.title}
                      </a>
                    ) : (
                      <span className="text-ink-3">尚无公开版本</span>
                    )}
                    {doc.withdrawn && <Badge tone="bad">已下架</Badge>}
                    {doc.publishing_paused && <Badge tone="warn">已暂停更新</Badge>}
                    {doc.automatic_excluded && <Badge>规则排除</Badge>}
                  </div>
                  <div className="mt-1 truncate text-[12.5px] text-ink-3">
                    {doc.original_title && doc.original_title !== doc.title ? `${doc.original_title} · ` : ""}
                    {doc.id} · 更新于 <Time at={doc.updated_at} />
                  </div>
                </div>
                {me.owner && (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" onClick={() => setChange({ doc, field: "paused", value: !doc.publishing_paused })}>
                      {WORDS.paused[doc.publishing_paused ? "off" : "on"].button}
                    </Button>
                    <Button
                      size="sm"
                      tone={doc.withdrawn ? "secondary" : "danger"}
                      onClick={() => setChange({ doc, field: "withdrawn", value: !doc.withdrawn })}
                    >
                      {WORDS.withdrawn[doc.withdrawn ? "off" : "on"].button}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ReasonDialog
        open={!!change}
        title={words?.title ?? ""}
        description={
          change && (
            <>
              <span className="block font-medium text-ink">{change.doc.title ?? change.doc.id}</span>
              <span className="mt-1 block">{words!.note}</span>
            </>
          )
        }
        confirmLabel={words?.button}
        danger={change?.field === "withdrawn" && change.value}
        busy={!!pending}
        onClose={() => setChange(null)}
        onSubmit={async (reason) => {
          if (!change) return false;
          const result = await run(
            "POST",
            `/api/admin/policies/${encodeURIComponent(change.doc.id)}/publication`,
            { [change.field]: change.value, reason },
            {
              success: words!.done,
              label: `${change.field}:${change.value}:${change.doc.id}`,
              parse: (value) => privateSchemas.AdminPolicyDocument.parse(value),
            },
          );
          if (result) setChange(null);
          return !!result;
        }}
      />
    </AdminPage>
  );
}
