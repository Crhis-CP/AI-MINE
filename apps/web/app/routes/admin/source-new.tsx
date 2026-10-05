import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import { SITE } from "@amp/industry/site";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/source-new";
import { useAdminAction } from "../../features/admin/action";
import { bj } from "../../features/admin/format";
import { KIND_LABEL, MODE_LABEL, TIER_LABEL } from "../../features/admin/labels";
import { AdminPage, Button, Card, Empty, Field, Input, Select, Textarea } from "../../features/admin/ui";

export const meta: Route.MetaFunction = () => [{ title: `新建信源 · ${SITE.name} 后台` }];

const TEMPLATES: Record<string, Record<string, unknown>> = {
  rss: { feedUrl: "https://example.com/feed.xml" },
  web_list: {
    url: "https://example.com/blog",
    baseUrl: "https://example.com",
    itemSelector: "article",
    linkSelector: "a",
    titleSelector: "h2",
    allowUrlPrefixes: ["https://example.com/blog/"],
  },
  json_list: {
    url: "https://example.com/api/posts",
    mode: "json_api",
    method: "GET",
    itemsPath: "data.items",
    titlePaths: ["title"],
    urlTemplate: "{raw:url}",
    summaryPaths: ["summary"],
  },
  mp_account: { biz: "", name: "" },
  external: {},
};

type ScopeEntry = { id: string; value: string };

interface Preview {
  ms: number;
  count: number;
  items: Array<{ title: string; url: string; publishedAt: string | null; excerpt: string }>;
}

export default function NewSource() {
  const navigate = useNavigate();
  const { run, pending } = useAdminAction();
  const [form, setForm] = useState({
    id: "",
    name: "",
    kind: "rss",
    tier: "T2",
    participation_mode: "editorial",
    interval_minutes: 30,
    first_party: false,
    site_fulltext: true,
    syndicate_fulltext: false,
    tags: "",
  });
  const [config, setConfig] = useState(JSON.stringify(TEMPLATES.rss, null, 2));
  const [scope, setScope] = useState<{ hosts: ScopeEntry[]; path_prefixes: ScopeEntry[]; document_types: ScopeEntry[]; excluded_content: ScopeEntry[] }>({
    hosts: [{ id: "initial-host", value: "" }],
    path_prefixes: [{ id: "initial-path", value: "/" }],
    document_types: [],
    excluded_content: [],
  });
  const [attachments, setAttachments] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);

  const parsed = () => {
    try {
      setError(null);
      return JSON.parse(config) as Record<string, unknown>;
    } catch (e) {
      setError(`配置不是合法 JSON：${(e as Error).message}`);
      return null;
    }
  };

  return (
    <AdminPage title="新建信源" subtitle="先判重、先预览：优先 RSS/JSON 等稳定协议；首抓成功且有真实条目才算接入完成。一手身份要有运营主体或官方交叉链接证据。">
      <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <Card title="信源定义">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="ID" hint="小写字母、数字和连字符，创建后不可改">
              <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} placeholder="mining-source" />
            </Field>
            <Field label="名称">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="矿业资讯来源" />
            </Field>
            <Field label="类型">
              <Select
                value={form.kind}
                onChange={(e) => {
                  setForm({ ...form, kind: e.target.value });
                  setConfig(JSON.stringify(TEMPLATES[e.target.value] ?? {}, null, 2));
                  setPreview(null);
                }}
              >
                {Object.entries(KIND_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="采集间隔（分钟）">
              <Input
                type="number"
                min={1}
                max={1440}
                value={form.interval_minutes}
                onChange={(e) => setForm({ ...form, interval_minutes: Number(e.target.value) })}
              />
            </Field>
            <Field label="参与方式">
              <Select value={form.participation_mode} onChange={(e) => setForm({ ...form, participation_mode: e.target.value })}>
                {Object.entries(MODE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="等级">
              <Select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
                {Object.entries(TIER_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="标签（逗号分隔）">
              <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
            </Field>
            <div className="flex flex-col justify-end gap-2 text-[13px] text-ink-2">
              {(
                [
                  ["first_party", "一手信源"],
                  ["site_fulltext", "站内可展示全文"],
                  ["syndicate_fulltext", "对外接口可带全文"],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={form[k]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <Field label="采集配置（JSON）">
              <Textarea className="font-mono !text-[12px]" rows={10} value={config} onChange={(e) => setConfig(e.target.value)} spellCheck={false} />
            </Field>
          </div>
          <fieldset className="mt-5 space-y-4 rounded-card border border-line-soft p-4">
            <legend className="px-1 text-[13px] font-medium text-ink">来源许可范围</legend>
            <p className="text-[12px] leading-relaxed text-ink-3">
              填写实际获准处理的范围。采集地址可能只是RSS托管地址，不会自动作为正文许可域名。加入后记录负责人声明，仍保持暂停。
            </p>
            <ScopeEntries
              label="域名"
              hint="例如 mining.example.org，只填域名，不含协议、端口或路径。"
              values={scope.hosts}
              onChange={(hosts) => setScope({ ...scope, hosts })}
              required
              placeholder="mining.example.org"
            />
            <ScopeEntries
              label="路径前缀"
              hint="以 / 开头；/ 表示整个域名，/news/ 表示该目录及其下属路径。"
              values={scope.path_prefixes}
              onChange={(path_prefixes) => setScope({ ...scope, path_prefixes })}
              required
              placeholder="/news/"
            />
            <details className="text-[13px] text-ink-2">
              <summary className="cursor-pointer font-medium">文类与排除内容（可选）</summary>
              <div className="mt-3 space-y-4">
                <ScopeEntries
                  label="文类"
                  hint="不添加表示不限文类；如有限定，请逐项填写实际文类名称。"
                  values={scope.document_types}
                  onChange={(document_types) => setScope({ ...scope, document_types })}
                  multiline
                />
                <ScopeEntries
                  label="排除内容"
                  hint="没有排除项可留空。无法确认内容符合这些条件时，不会自动处理。"
                  values={scope.excluded_content}
                  onChange={(excluded_content) => setScope({ ...scope, excluded_content })}
                  multiline
                />
              </div>
            </details>
            <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
              <input type="checkbox" checked={attachments} onChange={(e) => setAttachments(e.target.checked)} />
              附件纳入此许可范围
            </label>
          </fieldset>
          {error && (
            <p role="alert" className="mt-3 text-[12.5px] text-hot">
              {error}
            </p>
          )}
          {duplicate && (
            <div className="mt-4 rounded-card bg-amber/10 px-4 py-3 text-[13px] text-ink-2 ring-1 ring-amber/25">
              这个地址的信源已存在：
              <Link className="font-medium text-accent" to={`/admin/sources/${encodeURIComponent(duplicate.id)}`}>
                {duplicate.name}
              </Link>
              （{duplicate.id}）。没有新建。
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              busy={pending === "preview"}
              onClick={async () => {
                const c = parsed();
                if (!c) return;
                const r = await run<Preview>(
                  "POST",
                  "/api/admin/sources/preview",
                  { id: form.id || "draft", kind: form.kind, config: c },
                  { label: "preview", revalidate: false },
                );
                if (r) setPreview(r);
              }}
            >
              预览抓取
            </Button>
            <Button
              tone="primary"
              busy={pending === "create"}
              disabled={!form.id || !form.name}
              onClick={async () => {
                const c = parsed();
                if (!c) return;
                const input = privateSchemas.SourceCreateRequest.safeParse({
                  ...form,
                  config: c,
                  tags: form.tags
                    .split(/[,，]/)
                    .map((t) => t.trim())
                    .filter(Boolean),
                  permission_scope: {
                    hosts: scope.hosts.map(({ value }) => value.trim()).filter(Boolean),
                    path_prefixes: scope.path_prefixes.map(({ value }) => value.trim()).filter(Boolean),
                    document_types: scope.document_types.map(({ value }) => value).filter((value) => value.trim()),
                    excluded_content: scope.excluded_content.map(({ value }) => value).filter((value) => value.trim()),
                  },
                  attachments_in_scope: attachments,
                });
                if (!input.success) {
                  const field = input.error.issues[0]?.path;
                  setError(
                    field?.[1] === "hosts"
                      ? "请填写规范且不重复的域名，不含协议、端口或路径。"
                      : field?.[1] === "path_prefixes"
                        ? "请填写以 / 开头且不重复的规范路径，不含查询参数或 #。"
                        : "请检查信源字段及许可范围；文类和排除项不能重复。",
                  );
                  return;
                }
                const client = createPrivateClient({ baseUrl: window.location.origin });
                const r = await run("POST", "/api/admin/sources", input.data, {
                  label: "create",
                  revalidate: false,
                  send: (_url, init) => client.POST("/api/admin/sources", { body: input.data, headers: init.headers, signal: init.signal }),
                  parse: privateSchemas.SourceCreateResponse.parse,
                });
                if (!r) return;
                if (!r.created && r.duplicate) setDuplicate(r.duplicate);
                else if (r.created) navigate(`/admin/sources/${encodeURIComponent(r.source.id)}`);
              }}
            >
              创建
            </Button>
          </div>
        </Card>
        <Card title={preview ? `预览：${preview.count} 条（${preview.ms}ms）` : "预览"}>
          {!preview ? (
            <Empty>填好配置后点“预览抓取”，这里显示将会采集到的条目（不入库）。</Empty>
          ) : preview.items.length ? (
            <ul className="space-y-3">
              {preview.items.map((i) => (
                <li key={i.url} className="text-[13px]">
                  <a href={i.url} target="_blank" rel="noreferrer" className="font-medium text-ink hover:text-accent">
                    {i.title}
                  </a>
                  <div className="text-[12px] text-ink-4">{i.publishedAt ? bj(i.publishedAt, true) : "无发布时间"}</div>
                  {i.excerpt && <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{i.excerpt}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>没有抓到条目。</Empty>
          )}
        </Card>
      </div>
    </AdminPage>
  );
}

function ScopeEntries({
  label,
  hint,
  values,
  onChange,
  required = false,
  multiline = false,
  placeholder,
}: {
  label: string;
  hint: string;
  values: ScopeEntry[];
  onChange: (values: ScopeEntry[]) => void;
  required?: boolean;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="space-y-2">
        {values.map((entry, index) => (
          <div key={entry.id} className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              {multiline ? (
                <Textarea
                  aria-label={`${label} ${index + 1}`}
                  rows={2}
                  value={entry.value}
                  onChange={(e) => onChange(values.map((item, i) => (i === index ? { ...item, value: e.target.value } : item)))}
                />
              ) : (
                <Input
                  aria-label={`${label} ${index + 1}`}
                  value={entry.value}
                  placeholder={placeholder}
                  onChange={(e) => onChange(values.map((item, i) => (i === index ? { ...item, value: e.target.value } : item)))}
                />
              )}
            </div>
            <Button
              aria-label={`移除${label} ${index + 1}`}
              disabled={required && values.length === 1}
              onClick={() => onChange(values.filter((_item, i) => i !== index))}
            >
              移除
            </Button>
          </div>
        ))}
        <Button onClick={() => onChange([...values, { id: crypto.randomUUID(), value: "" }])}>添加{label}</Button>
      </div>
    </Field>
  );
}
