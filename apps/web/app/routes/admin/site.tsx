import { useRef, useState } from "react";
import type { z } from "zod";
import { SITE } from "@amp/industry/site";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import type { Route } from "./+types/site";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Card, Input, Button, Badge } from "../../features/admin/ui";
export const meta = () => [{ title: `网站资料 · ${SITE.name} 后台` }];
export async function loader({ request }: Route.LoaderArgs) {
  const path = "/api/admin/site",
    client = createPrivateClient({ baseUrl: "" });
  return privateSchemas.AdminSiteInformation.parse(
    await adminGet(request, path, (url, init) => client.GET(path, { baseUrl: new URL(url).origin, headers: init.headers, signal: init.signal })),
  );
}
type Information = z.infer<typeof privateSchemas.SiteInformation>;
const formOf = (info: Information) => ({
  about: info.about,
  email: info.contactEmail ?? "",
  page: info.contactPage ?? "",
  links: info.metalLinks.map((link, i) => ({ ...link, key: String(i) })),
});
export default function SiteSettings({ loaderData }: Route.ComponentProps) {
  const { information, protected: protectedInfo } = loaderData,
    { run, busy } = useAdminAction(),
    [form, setForm] = useState(() => formOf(information)),
    [revision, setRevision] = useState(information.revision),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false),
    nextKey = useRef(information.metalLinks.length);
  const update = (key: string, field: "name" | "url" | "note", value: string) =>
    setForm((f) => ({ ...f, links: f.links.map((link) => (link.key === key ? { ...link, [field]: value } : link)) }));
  return (
    <AdminPage
      title="网站资料"
      subtitle="维护公开介绍、联系方式和官方查询入口，保存后无需重新发布网站。"
      actions={
        <a href="/about" target="_blank" rel="noopener noreferrer" className="text-sm text-accent">
          查看公开关于页 ↗
        </a>
      }
    >
      {!protectedInfo.productionFilingConfigured && (
        <p role="status" className="mb-5 rounded-control border border-amber/30 bg-amber/10 p-4 text-sm text-amber-ink">
          公开站在生产环境不得开放：当前记录的备案配置尚不齐全，请在部署核对时补齐真实资料。
        </p>
      )}
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || conflict) return;
          setError("");
          const input = privateSchemas.SiteInformationUpdate.safeParse({
            expected_revision: revision,
            about: form.about,
            contactEmail: form.email.trim() || null,
            contactPage: form.page.trim() || null,
            metalLinks: form.links.map(({ key: _, ...link }) => ({ ...link, url: link.url.trim() })),
          });
          if (!input.success) {
            setError("请核对邮箱、完整HTTPS地址、入口名称和说明；关于文字不能超过5000字，地址不能重复。");
            return;
          }
          const client = createPrivateClient({ baseUrl: "" });
          const result = await run("PUT", "/api/admin/site", input.data, {
            success: "网站资料已保存，公开页面会读取新资料。",
            parse: (v) => privateSchemas.SiteInformation.parse(v),
            onConflict: () => setConflict(true),
            send: (_url, init) => client.PUT("/api/admin/site", { body: input.data, headers: init.headers, signal: init.signal }),
          });
          if (result) {
            setRevision(result.revision);
            setForm(formOf(result));
            nextKey.current = result.metalLinks.length;
            setConflict(false);
          }
        }}
      >
        <Card title={`关于 ${SITE.name}`}>
          <label htmlFor="site-about" className="block text-sm text-ink-3">
            公开介绍
          </label>
          <textarea
            id="site-about"
            value={form.about}
            maxLength={5000}
            rows={7}
            className="mt-2 w-full resize-y rounded-control border border-line bg-bg p-3 text-sm leading-relaxed text-ink focus:border-accent focus:outline-none"
            onChange={(e) => setForm({ ...form, about: e.target.value })}
          />
          <p className="mt-1 text-right text-xs text-ink-4">{form.about.length} / 5000</p>
        </Card>
        <Card title="联系方式">
          <div className="grid gap-4 md:grid-cols-2">
            <label htmlFor="site-email" className="block text-sm">
              公开联系邮箱
              <Input
                id="site-email"
                type="email"
                value={form.email}
                className="mt-2"
                maxLength={254}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label htmlFor="site-contact" className="block text-sm">
              联系页面
              <Input
                id="site-contact"
                type="url"
                value={form.page}
                className="mt-2"
                maxLength={2000}
                placeholder="https://"
                onChange={(e) => setForm({ ...form, page: e.target.value })}
              />
            </label>
          </div>
          <p className="mt-3 text-xs text-ink-3">未填写的资料不会展示。读者仍可通过反馈页面提交问题。</p>
        </Card>
        <Card
          title="金属价格官方入口"
          right={
            <a href="/metals" target="_blank" rel="noopener noreferrer" className="text-accent">
              查看价格页 ↗
            </a>
          }
        >
          <p className="mb-4 text-sm text-ink-3">这些链接只供读者查询；报价来源、许可和自动采集由现有登记配置管理。</p>
          <div className="space-y-4">
            {form.links.map((link, index) => (
              <div key={link.key} className="rounded-control border border-line bg-bg p-3">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-medium">入口 {index + 1}</span>
                  <Button type="button" disabled={busy} onClick={() => setForm({ ...form, links: form.links.filter((item) => item.key !== link.key) })}>
                    移除
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label htmlFor={`site-link-name-${link.key}`} className="text-sm">
                    名称
                    <Input
                      id={`site-link-name-${link.key}`}
                      className="mt-1"
                      value={link.name}
                      required
                      maxLength={100}
                      onChange={(e) => update(link.key, "name", e.target.value)}
                    />
                  </label>
                  <label htmlFor={`site-link-url-${link.key}`} className="text-sm">
                    HTTPS 地址
                    <Input
                      id={`site-link-url-${link.key}`}
                      className="mt-1"
                      type="url"
                      value={link.url}
                      required
                      maxLength={2000}
                      onChange={(e) => update(link.key, "url", e.target.value)}
                    />
                  </label>
                </div>
                <label htmlFor={`site-link-note-${link.key}`} className="mt-3 block text-sm">
                  一句说明
                  <Input
                    id={`site-link-note-${link.key}`}
                    className="mt-1"
                    value={link.note}
                    required
                    maxLength={300}
                    onChange={(e) => update(link.key, "note", e.target.value)}
                  />
                </label>
              </div>
            ))}
          </div>
          {form.links.length === 0 && <p className="mb-3 text-sm text-ink-3">未设置官方入口，公开页面会隐藏此区块。</p>}
          <Button
            type="button"
            className="mt-4"
            disabled={busy || form.links.length >= 30}
            onClick={() => setForm({ ...form, links: [...form.links, { key: String(nextKey.current++), name: "", url: "", note: "" }] })}
          >
            添加入口
          </Button>
        </Card>
        {conflict && (
          <Card title="资料已更新">
            <p className="text-sm text-amber-ink">其他操作已保存新资料。你的输入已保留，请核对后再保存。</p>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-accent">查看当前已保存的资料</summary>
              <p className="mt-2 whitespace-pre-wrap">{information.about || "未填写关于文字"}</p>
              <p className="mt-2 break-all">
                {information.contactEmail ?? "未填写邮箱"} · {information.contactPage ?? "未填写联系页"}
              </p>
              <ul className="mt-2 space-y-1">
                {information.metalLinks.map((link) => (
                  <li key={link.url} className="break-all">
                    {link.name} · {link.url} · {link.note}
                  </li>
                ))}
              </ul>
            </details>
            <Button
              type="button"
              className="mt-3"
              disabled={busy}
              onClick={() => {
                setRevision(information.revision);
                setConflict(false);
              }}
            >
              已核对，保留我的填写
            </Button>
          </Card>
        )}
        {error && (
          <p role="alert" className="text-sm text-hot">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" tone="primary" disabled={busy || conflict}>
            {busy ? "正在保存…" : "保存网站资料"}
          </Button>
        </div>
      </form>
      <Card title="受保护的展示配置 · 只读" className="mt-7">
        <p className="mb-4 text-sm text-ink-3">备案与许可资料由负责人安全提供，本页不能修改。下方是当前程序的配置与展示状态。</p>
        <dl className="divide-y divide-line">
          {(
            [
              ["ICP备案", protectedInfo.icp],
              ["公安联网备案", protectedInfo.publicSecurity],
              ["新闻信息服务许可证", protectedInfo.newsLicense],
            ] as const
          ).map(([name, check]) => (
            <div key={name} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <dt className="text-sm font-medium">{name}</dt>
              <dd className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <Badge tone={check.configured ? "ok" : "warn"}>{check.configured ? "已配置" : "未配置"}</Badge>
                <span>{check.origin === "build" ? "随网站版本发布" : check.origin === "runtime" ? "受控运行配置" : "尚未记录"}</span>
                <span>页脚：{check.footerDisplayed ? "按配置展示" : "不展示"}</span>
                {name === "新闻信息服务许可证" && <span>关于页：{check.aboutDisplayed ? "按配置展示" : "不展示"}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <p>
            许可证有效期：
            {protectedInfo.newsLicenseValidUntil ?? (protectedInfo.newsLicenseDateState === "invalid" ? "记录格式无效，请通过受控配置修正" : "未记录")}
          </p>
          <p>剩余天数：{protectedInfo.remainingDays === null ? "无法核对" : `${protectedInfo.remainingDays} 天`}</p>
          <p className="break-all sm:col-span-2">
            网站地址：{protectedInfo.siteUrl}（{protectedInfo.siteUrlOrigin === "runtime" ? "运行配置" : "构建默认值"}）
          </p>
        </div>
        <p className="mt-4 text-xs text-ink-3">有效期尚未记录时，不推断许可是否有效。网站名称、品牌与隐私条款不在本页编辑。</p>
      </Card>
    </AdminPage>
  );
}
