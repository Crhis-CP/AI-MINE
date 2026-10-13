import { useState } from "react";
import type { z } from "zod";
import { createPrivateClient, privateSchemas } from "@amp/api-client/private";
import { useAdminAction } from "./action";
import { Badge, Button, Card, Field, Input, ReasonDialog, Select } from "./ui";
import { bj } from "./format";
type Data = z.infer<typeof privateSchemas.UsageProtectionOverview>;
type Config = z.infer<typeof privateSchemas.UsageProtectionConfig>;
type Price = z.infer<typeof privateSchemas.UsagePriceRecord>;
const decimal = (value: string, scale: number) => {
  const n = BigInt(value),
    factor = 10n ** BigInt(scale);
  return `${n / factor}${
    n % factor
      ? "." +
        String(n % factor)
          .padStart(scale, "0")
          .replace(/0+$/, "")
      : ""
  }`;
};
const money = (value: string | undefined) => (value === undefined ? "未确认" : `${decimal(value, 6)} 元`);
const micros = (value: string) => {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim())) throw new Error("金额须为非负人民币数，最多6位小数。");
  const [a, b = ""] = value.trim().split(".");
  return (BigInt(a!) * 1000000n + BigInt(b.padEnd(6, "0"))).toString();
};
const rate = (value: string) => {
  if (!/^\d+(?:\.\d{1,8})?$/.test(value.trim())) throw new Error("单价须为非负人民币数，最多8位小数。");
  const [a, b = ""] = value.trim().split(".");
  const n = BigInt(a!) * 100000000n + BigInt(b.padEnd(8, "0"));
  return `${n / 100n}${
    n % 100n
      ? "." +
        String(n % 100n)
          .padStart(2, "0")
          .replace(/0+$/, "")
      : ""
  }`;
};
const yuanRate = (value: string | null) =>
  value === null ? "" : decimal((BigInt(value.split(".")[0]!) * 100n + BigInt((value.split(".")[1] ?? "").padEnd(2, "0"))).toString(), 8);
const triggerName = { repeated_input: "同一输入重复付费", object_cost: "单对象累计费用", daily_total: "单日总费用异常" };
const laneName = (lane: string) => (lane === "policy" ? "法规" : lane === "news" ? "资讯" : lane);
const scopeName = (b: Data["breakers"][number]) =>
  `${laneName(b.scope.lane)} · ${b.scope.object_id ?? b.scope.capability ?? "该范围"}${b.scope.source_id ? ` · 来源 ${b.scope.source_id}` : ""}`;
const configFields: Array<{ key: keyof Config["breaker"]; label: string; unit: "number" | "money" | "ratio" }> = [
  { key: "repeat_count", label: "同一输入重复次数", unit: "number" },
  { key: "repeat_window_seconds", label: "重复计数窗口（秒）", unit: "number" },
  { key: "news_object_micros", label: "单篇资讯异常费用（元）", unit: "money" },
  { key: "policy_object_micros", label: "单份法规异常费用（元）", unit: "money" },
  { key: "daily_multiple", label: "日费用相对历史日均的倍数", unit: "ratio" },
  { key: "daily_floor_micros", label: "日费用绝对额条件（元）", unit: "money" },
  { key: "daily_no_history_micros", label: "没有费用历史时的日界（元）", unit: "money" },
  { key: "lookback_days", label: "日均回看天数", unit: "number" },
];
function ConfigForm({ data }: { data: Data }) {
  const seed = data.configuration?.config ?? data.initial_config,
    { run, pending } = useAdminAction();
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    seed
      ? Object.fromEntries([
          ...configFields.map((f) => [f.key, f.unit === "money" ? decimal(String(seed.breaker[f.key]), 6) : String(seed.breaker[f.key])]),
          ["warning", String(Number(seed.breaker.warning_ratio) * 100)],
          ["step", decimal(seed.usage_notice.step_micros, 6)],
          ["time", seed.usage_report.push_time],
          ["unknown_amount", decimal(seed.unknown_alert.amount_micros, 6)],
          ["unknown_age", String(seed.unknown_alert.oldest_age_seconds)],
        ])
      : {},
  );
  const [confirm, setConfirm] = useState(false),
    [error, setError] = useState("");
  if (!seed) return <p className="text-sm text-ink-3">初始保护规则不可读取，请先修复部署资料；系统不会自行填阈值放行。</p>;
  const build = () => {
    const next = structuredClone(seed);
    for (const f of configFields) {
      const v = draft[f.key] ?? "";
      Object.assign(next.breaker, { [f.key]: f.unit === "number" ? Number(v) : f.unit === "money" ? micros(v) : v });
    }
    if (!/^\d+(?:\.\d{1,4})?$/.test(draft.warning ?? "")) throw new Error("预警比例须为百分数，最多4位小数。");
    next.breaker.warning_ratio = decimal((BigInt(micros(draft.warning!)) / 100n).toString(), 6);
    next.usage_notice.step_micros = micros(draft.step!);
    next.usage_report.push_time = draft.time!;
    next.unknown_alert = { amount_micros: micros(draft.unknown_amount!), oldest_age_seconds: Number(draft.unknown_age) };
    return privateSchemas.UsageProtectionConfig.parse(next);
  };
  return (
    <details className="mt-4 rounded-lg border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">{data.configuration ? "调整保护规则" : "安装项目既定的初始保护规则"}</summary>
      <p className="mt-3 text-sm text-ink-3">这些是异常保护条件，不是月度额度。修改立即作用于之后的新付费请求，不会自动恢复已熔断的范围。</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {configFields.map((f) => (
          <Field key={f.key} label={f.label}>
            <Input value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} inputMode="decimal" />
          </Field>
        ))}
        <Field label="预警比例（%）">
          <Input value={draft.warning ?? ""} onChange={(e) => setDraft({ ...draft, warning: e.target.value })} inputMode="decimal" />
        </Field>
        <Field label="月内用量提示步长（元，只提示）">
          <Input value={draft.step ?? ""} onChange={(e) => setDraft({ ...draft, step: e.target.value })} inputMode="decimal" />
        </Field>
        <Field label="月报推送时刻（北京时间）">
          <Input type="time" value={draft.time ?? ""} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
        </Field>
        <Field label="未知费用占用提醒（元）">
          <Input value={draft.unknown_amount ?? ""} onChange={(e) => setDraft({ ...draft, unknown_amount: e.target.value })} inputMode="decimal" />
        </Field>
        <Field label="未知费用最长账龄提醒（秒）">
          <Input value={draft.unknown_age ?? ""} onChange={(e) => setDraft({ ...draft, unknown_age: e.target.value })} inputMode="numeric" />
        </Field>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <Button
        tone="primary"
        className="mt-4"
        onClick={() => {
          try {
            build();
            setError("");
            setConfirm(true);
          } catch {
            setError("请检查所有必填规则：金额、天数及次数必须有效，预警比例须大于0且小于100%。");
          }
        }}
      >
        核对并保存规则
      </Button>
      <ReasonDialog
        open={confirm}
        title="确认修改费用保护规则"
        danger
        description="请核对页面填写的新值。阈值过低会让正常处理进入等待；这次修改不会解除人工暂停、部署保护或已存在的熔断。"
        confirmLabel="确认保存"
        busy={pending === "usage-config"}
        onClose={() => setConfirm(false)}
        onSubmit={async (reason) => {
          const body = { expected_version: data.configuration?.version ?? 0, config: build(), reason, high_risk_confirmed: true as const },
            client = createPrivateClient({ baseUrl: window.location.origin });
          const result = await run("PUT", "/api/admin/usage-config", body, {
            label: "usage-config",
            success: "保护规则已保存",
            parse: privateSchemas.UsageConfigRecord.parse,
            send: (_url, init) => client.PUT("/api/admin/usage-config", { body, headers: init.headers }),
          });
          return result !== null;
        }}
      />
    </details>
  );
}
function PriceForm({ data, existing }: { data: Data; existing?: Price }) {
  const { run, pending } = useAdminAction();
  const matched = data.pricing_models.find(
    (m) => m.service === existing?.price.service && m.model === existing?.price.model && m.configuration_hash === existing?.price.configuration_hash,
  );
  const [selected, setSelected] = useState(matched?.key ?? (existing ? "custom" : ""));
  const [draft, setDraft] = useState(() => ({
    service: existing?.price.service ?? "",
    model: existing?.price.model ?? "",
    hash: existing?.price.configuration_hash ?? "",
    input: yuanRate(existing?.price.input_per_million_micros ?? null),
    output: yuanRate(existing?.price.output_per_million_micros ?? null),
    fixed: existing?.price.per_request_micros === null || existing === undefined ? "" : decimal(existing.price.per_request_micros, 6),
    maximum: existing?.price.max_request_micros === null || existing === undefined ? "" : decimal(existing.price.max_request_micros, 6),
    image: String(existing?.price.image_input_token_bound ?? ""),
    protocol: String(existing?.price.protocol_input_token_allowance ?? ""),
    basis: existing?.price.basis_url ?? "",
    observed: existing?.price.observed_on ?? "",
    until: existing?.price.valid_until ?? "",
  }));
  const [confirm, setConfirm] = useState(false),
    [error, setError] = useState("");
  const option = data.pricing_models.find((m) => m.key === selected);
  const set = (key: keyof typeof draft, value: string) => setDraft({ ...draft, [key]: value });
  const build = () =>
    privateSchemas.UsagePrice.parse({
      service: draft.service.trim(),
      model: draft.model.trim(),
      configuration_hash: draft.hash || null,
      currency: "CNY",
      input_per_million_micros: draft.input ? rate(draft.input) : null,
      output_per_million_micros: draft.output ? rate(draft.output) : null,
      per_request_micros: draft.fixed ? micros(draft.fixed) : null,
      max_request_micros: draft.maximum ? micros(draft.maximum) : null,
      image_input_token_bound: draft.image ? Number(draft.image) : null,
      protocol_input_token_allowance: draft.protocol === "" ? undefined : Number(draft.protocol),
      basis_url: draft.basis,
      observed_on: draft.observed,
      valid_until: draft.until,
    });
  return (
    <details className="mt-3 rounded-lg border border-line p-4">
      <summary className="cursor-pointer text-sm font-medium">
        {existing ? `复核价格 · ${existing.price.model || existing.price.service}` : "登记当前有效价格"}
      </summary>
      <p className="mt-3 text-sm text-ink-3">
        使用人民币原价，不换算美元。已登记模型的金额和依据沿用模型接入记录；单价保留最多8位小数，费用最终以微元保守估算。
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="计费对象">
          <Select
            value={selected}
            onChange={(e) => {
              const key = e.target.value,
                m = data.pricing_models.find((c) => c.key === key);
              setSelected(key);
              if (m)
                setDraft({
                  ...draft,
                  service: m.service,
                  model: m.model,
                  hash: m.configuration_hash,
                  input: m.input_cny_per_million ?? "",
                  output: m.output_cny_per_million ?? "",
                  basis: m.basis_url ?? "",
                  fixed: "",
                  maximum: "",
                  image: "",
                  protocol: "",
                  observed: "",
                  until: "",
                });
              else setDraft({ ...draft, service: "", model: "", hash: "", input: "", output: "", basis: "", protocol: "" });
            }}
          >
            <option value="">请选择</option>
            {data.pricing_models.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
                {m.registered ? " · 已接入" : " · 现有环境模型"}
              </option>
            ))}
            <option value="custom">其他按请求计费的服务</option>
          </Select>
        </Field>
        {selected === "custom" && (
          <Field label="服务标识" hint="填已有服务标识，例如 jina 或 dajiala；不会新开通供应商。">
            <Input value={draft.service} onChange={(e) => set("service", e.target.value)} />
          </Field>
        )}
        {selected !== "custom" && (
          <>
            <Field label="输入单价（元 / 百万 token）">
              <Input readOnly={option?.registered} value={draft.input} onChange={(e) => set("input", e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="输出单价（元 / 百万 token）">
              <Input readOnly={option?.registered} value={draft.output} onChange={(e) => set("output", e.target.value)} inputMode="decimal" />
            </Field>
          </>
        )}
        {selected === "custom" && (
          <>
            <Field label="每次请求固定费用（元）">
              <Input value={draft.fixed} onChange={(e) => set("fixed", e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="单次最坏费用依据（元）" hint="没有可核上界时留待配置，不能猜测。">
              <Input value={draft.maximum} onChange={(e) => set("maximum", e.target.value)} inputMode="decimal" />
            </Field>
          </>
        )}
        <Field label="计费依据链接（HTTPS）">
          <Input type="url" readOnly={option?.registered} value={draft.basis} onChange={(e) => set("basis", e.target.value)} />
        </Field>
        <Field label="价格观察日期">
          <Input type="date" value={draft.observed} onChange={(e) => set("observed", e.target.value)} />
        </Field>
        <Field label="价格有效至" hint="距观察日期不超过45天；到期只拦该价格下的新付费请求。">
          <Input type="date" value={draft.until} onChange={(e) => set("until", e.target.value)} />
        </Field>
        <Field label="协议额外输入上界（token）" hint="按供应商可核规则填写；固定按次计费可填0。">
          <Input value={draft.protocol} onChange={(e) => set("protocol", e.target.value)} inputMode="numeric" />
        </Field>
        {option?.vision && (
          <Field label="每张图像输入上界（token）" hint="没有可核规则可暂留空；文字测试仍可进行，图像请求会等待配置。">
            <Input value={draft.image} onChange={(e) => set("image", e.target.value)} inputMode="numeric" />
          </Field>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <Button
        tone="primary"
        className="mt-4"
        onClick={() => {
          try {
            if (!selected) throw new Error();
            build();
            setError("");
            setConfirm(true);
          } catch {
            setError("请填写当前计费规则、HTTPS依据及有效期。价格不能缺项，图像上界不能猜测。");
          }
        }}
      >
        核对并保存价格
      </Button>
      <ReasonDialog
        open={confirm}
        title="确认当前计费依据"
        danger
        description="价格只影响之后的新付费请求；历史费用保留原依据。修改价格不会改变模型选择或授予内容质量资格。"
        confirmLabel="确认有效价格"
        busy={pending === "usage-price"}
        onClose={() => setConfirm(false)}
        onSubmit={async (reason) => {
          const price = build(),
            prior = data.prices.find(
              (p) => p.price.service === price.service && p.price.model === price.model && p.price.configuration_hash === price.configuration_hash,
            ),
            body = { expected_version: prior?.version ?? 0, price, reason, high_risk_confirmed: true as const },
            client = createPrivateClient({ baseUrl: window.location.origin });
          return (
            (await run("PUT", "/api/admin/usage-prices", body, {
              label: "usage-price",
              success: "有效价格已保存",
              parse: privateSchemas.UsagePriceRecord.parse,
              send: (_url, init) => client.PUT("/api/admin/usage-prices", { body, headers: init.headers }),
            })) !== null
          );
        }}
      />
    </details>
  );
}
export function UsageProtection({ data }: { data: Data | null }) {
  const { run, pending } = useAdminAction(),
    [recover, setRecover] = useState<Data["breakers"][number] | null>(null);
  if (!data)
    return (
      <Card title="费用保护">
        <p className="text-sm text-ink-3">费用保护记录暂时无法读取；没有把它显示为正常或零费用。</p>
      </Card>
    );
  const open = data.breakers.filter((b) => b.state === "open");
  return (
    <Card title="费用保护与有效价格">
      <p className="text-sm text-ink-3">不设月度金额上限。预警只提醒；熔断只暂停被点名范围的新付费请求，公开阅读与已付回执复用继续。</p>
      {!!data.missing.length && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{data.missing.join("；")}。未能核实的金额不会填成0。</div>
      )}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {data.indicators.map((i) => (
          <div key={`${i.trigger}-${i.current.lane ?? "all"}`} className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm">
                {triggerName[i.trigger]}
                {i.current.lane ? ` · ${laneName(i.current.lane)}` : ""}
              </strong>
              <Badge tone={i.level === "tripped" ? "bad" : i.level === "warning" ? "warn" : "ok"}>
                {i.level === "tripped" ? "有未恢复熔断" : i.level === "warning" ? "预警" : "正常"}
              </Badge>
            </div>
            <p className="mt-2 text-sm">
              {i.trigger === "repeated_input"
                ? `当前最高重复 ${i.current.repeats} 次；预警 ${i.threshold.warning} 次，熔断 ${i.threshold.limit} 次。`
                : i.trigger === "object_cost"
                  ? `当前最高 ${money(i.current.micros)}；预警 ${money(i.threshold.warning_micros)}，超过 ${money(i.threshold.micros)} 熔断。`
                  : `今日已记录 ${money(i.current.micros)}；参考 ${i.current.history_days} 个完整自然日。需同时超过日均 ${i.threshold.multiple} 倍与 ${money(i.threshold.floor_micros)}；无历史时超过 ${money(i.threshold.no_history_micros)}。`}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-3">
        {open.length ? (
          open.map((b) => (
            <div key={b.id} className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-semibold">
                {triggerName[b.trigger]} · {scopeName(b)}
              </p>
              <p className="mt-1 text-xs text-ink-3">
                触发于 {bj(b.opened_at ?? b.created_at)}，使用保护规则版本 {b.config_version}。恢复只作用于这一范围。
              </p>
              {data.can_manage && (
                <Button className="mt-2" size="sm" onClick={() => setRecover(b)}>
                  恢复此范围
                </Button>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm text-ink-3">当前没有已记录且尚未恢复的费用熔断。</p>
        )}
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium">查看预警、恢复及用量提示记录</summary>
        <ul className="mt-3 space-y-2 text-sm">
          {data.events.length ? (
            data.events.map((e) => (
              <li key={e.id} className="border-b border-line py-2">
                {bj(e.created_at)} ·{" "}
                {
                  {
                    warning: "费用预警",
                    opened: "熔断或持续提醒",
                    recovered: "已恢复",
                    configuration_changed: "配置更新",
                    configuration_missing: "费用记录或配置缺项",
                    usage_notice: "用量提示（不暂停）",
                    unknown_usage: "未知费用提醒",
                  }[e.kind]
                }{" "}
                · {{ pending: "等待发送", sent: "已发送", disabled: "渠道未启用", unknown: "送达结果待核对" }[e.delivery_status]}
                {e.kind === "usage_notice"
                  ? ` · 累计 ${money(typeof e.payload.cumulative_micros === "string" ? e.payload.cumulative_micros : undefined)}`
                  : typeof e.payload.reason === "string"
                    ? ` · ${e.payload.reason}`
                    : ""}
              </li>
            ))
          ) : (
            <li>尚无保护或提示记录。</li>
          )}
        </ul>
      </details>
      <div className="mt-5 border-t border-line pt-4">
        <h3 className="text-sm font-semibold">当前登记价格</h3>
        <p className="mt-1 text-sm text-ink-3">完成有效价格登记后，模型接入页才能进行最小连接测试。</p>
        {data.prices.length ? (
          <ul className="mt-3 space-y-2 text-sm">
            {data.prices.map((p) => (
              <li key={p.id} className="rounded border border-line p-3">
                <strong>{p.price.model || p.price.service}</strong> · 有效至 {p.price.valid_until} ·{" "}
                <a className="underline" href={p.price.basis_url} target="_blank" rel="noreferrer">
                  计费依据
                </a>
                <span className="ml-2 text-ink-3">
                  {p.price.input_per_million_micros !== null
                    ? `输入 ${yuanRate(p.price.input_per_million_micros)} / 输出 ${yuanRate(p.price.output_per_million_micros)} 元每百万 token`
                    : `按次 ${p.price.per_request_micros === null ? "费用尚须回执核实" : money(p.price.per_request_micros)}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-ink-3">还没有有效价格记录；系统不会自行猜测供应商单价。</p>
        )}
        {data.can_manage ? (
          <>
            <PriceForm key={`new-${data.prices.map((p) => p.version).join("-")}`} data={data} />
            {data.prices.map((p) => (
              <PriceForm key={`${p.id}-${p.version}`} data={data} existing={p} />
            ))}
            <ConfigForm key={data.configuration?.version ?? 0} data={data} />
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-3">你可以查看费用与记录；价格、规则修改和熔断恢复须由负责人操作。</p>
        )}
      </div>
      <ReasonDialog
        open={!!recover}
        title="恢复这个费用范围"
        description={recover ? `${scopeName(recover)}。恢复不改变阈值，也不解除人工或部署暂停；同一异常条件再次满足时会再次熔断。` : ""}
        confirmLabel="确认恢复"
        busy={pending === "recover-breaker"}
        onClose={() => setRecover(null)}
        onSubmit={async (reason) => {
          if (!recover) return false;
          const body = { expected_revision: recover.revision, reason },
            client = createPrivateClient({ baseUrl: window.location.origin });
          return (
            (await run("POST", `/api/admin/breakers/${encodeURIComponent(recover.id)}/recover`, body, {
              label: "recover-breaker",
              success: "所选费用范围已恢复",
              parse: privateSchemas.UsageBreaker.parse,
              send: (_url, init) => client.POST("/api/admin/breakers/{id}/recover", { params: { path: { id: recover.id } }, body, headers: init.headers }),
            })) !== null
          );
        }}
      />
    </Card>
  );
}
