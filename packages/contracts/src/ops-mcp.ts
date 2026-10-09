import { z } from "zod";
const count = z.number().int().nonnegative(),
  stamp = z.iso.datetime({ offset: true }).nullable();
const key = z.string().max(160);
export const OpsDataset = z.enum([
  "health",
  "runs",
  "sources",
  "processing",
  "acquisition",
  "usage",
  "protection",
  "publication",
  "audit",
  "accounts",
  "feedback",
  "evaluations",
  "queues",
]);
const numericValues = z.record(z.string().regex(/^[a-z_]+$/), z.string().regex(/^\d+(?:\.\d+)?$/));
export const OpsRows = {
  protection: z
    .array(
      z.strictObject({
        kind: z.enum(["indicator", "breaker", "coverage"]),
        state: z.enum(["normal", "warning", "tripped", "open", "recovered", "needs_configuration"]),
        lane: z.enum(["news", "policy"]).nullable(),
        trigger: z.enum(["repeated_input", "object_cost", "daily_total"]).nullable(),
        capability: key.nullable(),
        source_id: key.nullable(),
        current: numericValues,
        threshold: numericValues,
      }),
    )
    .max(501),
  runs: z.array(z.strictObject({ job: key, status: key, count, latest_at: stamp })).max(501),
  health: z.array(z.strictObject({ component: z.enum(["worker", "private-api", "backup_record"]), last_recorded_at: stamp })).max(3),
  sources: z
    .array(
      z.strictObject({
        source_id: key,
        lane: z.enum(["news", "policy"]),
        kind: key,
        enabled: z.boolean(),
        health: key,
        last_ok_at: stamp,
        last_fetch_at: stamp,
        next_fetch_at: stamp,
      }),
    )
    .max(501),
  processing: z.array(z.strictObject({ source_id: key, state: key, count })).max(501),
  acquisition: z.array(z.strictObject({ source_id: key, status: key, count, latest_at: stamp })).max(501),
  usage: z
    .array(
      z.strictObject({
        service: key,
        status: key,
        currency: z.string().max(12).nullable(),
        cost_basis: z.enum(["actual", "estimated"]).nullable(),
        calls: count,
        recorded_amount: z
          .string()
          .regex(/^-?[0-9]+(\.[0-9]+)?$/)
          .nullable(),
        priced_calls: count,
      }),
    )
    .max(501),
  publication: z.array(z.strictObject({ kind: z.enum(["news", "policy"]), state: key, count, latest_at: stamp })).max(100),
  audit: z
    .array(
      z.strictObject({
        id: z.string().regex(/^\d+$/),
        action: z
          .string()
          .regex(/^[a-z_]+(?:\.[a-z_]+)*$/)
          .max(120),
        at: stamp,
      }),
    )
    .max(101),
  accounts: z
    .array(z.strictObject({ role: z.enum(["owner", "admin"]), active: z.boolean(), models_manage: z.boolean(), must_change_password: z.boolean(), count }))
    .max(32),
  feedback: z.array(z.strictObject({ status: key, count })).max(32),
  evaluations: z.array(z.strictObject({ id: key, sample_size: count, model_count: count, created_at: stamp })).max(101),
  queues: z.array(z.strictObject({ name: key, state: key, count, oldest_at: stamp })).max(501),
};
export const OpsReadInput = z.strictObject({
  dataset: OpsDataset,
  offset: z.number().int().min(0).max(500).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export const OPS_EXCLUSIONS = ["密钥及凭据", "个人信息与账号标识", "第三方正文和提示词", "原始日志、错误原文与审计前后值", "SQL、命令执行和业务写入"] as const;
export const OPS_COVERAGE: Record<z.infer<typeof OpsDataset>, string> = {
  runs: "最近24小时的持久运行记录，按任务及状态分组；不返回错误原文或运行结果载荷",
  health: "最近已记录的worker/API心跳和备份记录时间；记录不等于服务健康或恢复演练成功",
  sources: "按来源ID最多500项配置状态与成功时间；不含地址、许可正文或未记录来源",
  processing: "当前材料按来源和处理状态统计，最多500组；包含两条业务线，不把已处理推断为已公开",
  acquisition: "最近24小时的来源采集状态分组，最多500组；延后/跳过不算采集成功",
  protection: "采样时的费用预警、熔断与覆盖缺项；数值以人民币微元或标注的计数/比例为单位，不含回执正文、人员或恢复原因",
  usage: "北京时间本月真实物理尝试按服务/状态/币种/费用依据分列；未定价和未知保持缺项，不跨币种合计",
  publication: "资讯投影及法规当前投影状态计数；法规投影计数不代表当前质量资格通过",
  audit: "最近100次记录的动作类型和时刻；不含操作人、对象标识、原因、前后值和请求元数据",
  accounts: "当前已明确绑定的账号按角色/状态汇总；不含姓名、登录名、邮箱、会话或密码",
  feedback: "当前反馈按处理状态汇总；不含反馈正文、联系方式、截图或来源IP",
  evaluations: "最近100次评测的记录ID、样本与模型数量；不含样本文字、模型答案或人工备注",
  queues: "持久任务按队列与状态汇总，最多500组；不含任务载荷、返回值和错误原文",
};
