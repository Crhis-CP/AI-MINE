# 任务卡模板（新仓库 `tasks/_template.md`；实例 `tasks/TASK-<四位序号>.md`）

> 用法：架构 Agent 随“计划 PR”或“契约 PR”把卡合并进 `main` 的 `tasks/` 目录，`make verify` 的 `path-guard` 与 `tasks` 阶段读取它（`docs/06-agents/01-parallel-development-rules.md` 第 3.3、6.3 节）；路径守卫以 **PR base（main）上的版本**为准，作者不能在同一 PR 里放宽自己的路径。复制本模板，序号递增、不复用。
> 一个任务 = 一个模块（可附本模块契约）+ 一个可验收的行为增量，有效改动 ≤400 行（不含生成物、夹具、快照、`move-only` 纯搬移）。**写不清“验收命令”的任务不允许开工。**
> **卡不是审批表**：Owner 只通过 `owner_decision_needed` 与 Q 卡片介入，不做逐步批准；卡上没有“待 Owner 批准”这一状态。
> 编号：任务卡 `TASK-nnnn`；路线图任务包 `T-<四位>`（`wbs` 字段）；验收场景 `T-<三位>`（`scenarios` 字段）；旧法规分支验收 `POL-T01`～`POL-T63`。PR 分支名 `agent/<lane>/TASK-<编号>-<slug>`。

```yaml
---
# ───────── 必填（缺任何一项，tasks 阶段失败）─────────
id: TASK-0000                   # 全局唯一、递增，与文件名一致
wbs: T-<四位>                    # 对应 docs/06-agents/02-roadmap-and-wbs.md 的任务包
lane: <泳道名>                    # 取自 lanes.yaml，例如 sources / policy / publish / web
title: <动词开头，一句话说明交付的行为>
milestone: <M0 | M1 | M2 | M3 | M4 | M5>  # 全部排期功能在切换前（M0–M4）完成，没有“切换后”
specs:                          # 至少一个，必须真实存在；功能 / 规则 / 验收
  - F-<域>-<nn>
  - BR-<域>-<nn>
  - AC-<域>-<nn>
allowed_paths:                  # 路径守卫依据；PR 改动的每个文件必须落在这里
  - packages/domains/<module>/**
  - database/migrations/<module>/**
  - packages/contracts/src/<module>/**
  - docs/<相关规格文件>
verify:                         # 验收命令；必须能在干净环境重复执行，且不访问外网与真实模型
  - pnpm test --filter @amp/<module>
contracts:
  change: none                  # none | additive | breaking（breaking 必须附 ADR）
  files: []
base_sha: <创建分支时 main 的完整 40 位提交>

# ───────── 选填（括号内是默认值）─────────
depends_on: []                  # 必须已合并的任务或契约 PR
blocks: []
read_only_deps: []              # 只读依赖的路径或模块公开接口
contract_versions: {}           # {契约包名: 内容哈希}；凡消费契约必填，verify 发现 main 上哈希已变即报“消费者基于过期契约”
integration_owner: ""           # 触及共享区（公共类型、根配置、锁文件、组合根逻辑）必填，写集成人与批准记录
upstream_ports: []              # 凡移植 AIHOT 文件必填：[{aihot_path, sha256, target, license_note}]，同步登记 upstream/aihot.lock.json
budget:                         # 防越权：默认只用假模型与录制夹具
  model_calls: 0                # 开发/验收允许的真实模型最大调用次数（即样本量，不是金额；不设月度金额上限，没有 cny_limit 字段）；默认 0
invariants_touched: []          # INV-<nn>
pitfalls_to_avoid: []           # PIT-<nnn>
scenarios: []                   # 验收场景 T-<三位>；法规线可写 POL-T<nn>
pages: []                       # PG-<nn> / OP-<nn>
owner_decision_needed: []       # 待 Owner 回答的 Q 编号；没有写 []（硬前置类问题——如矿业版评分标准审阅——未确认前不得合并依赖它的行为变化）
stop_conditions:                # 越界条件：出现即停止、写入“交付记录”、开新卡，不要自行扩大范围
  - 发现契约须改 → 停止消费者 PR，开契约卡，从新 main 重建
  - 需要写入 allowed_paths 之外的文件 → 拆任务或请架构 Agent 开计划 PR
  - 需要超出 budget 的真实模型调用 → 停止并发 Q 卡片
status: specified               # specified | implemented | locally_verified | integrated | live_verified | quality_accepted
evidence: []                    # 交付证据（完成后填）：验证回执、合并记录、部署读回、验收记录的链接
---
```

## 背景（为什么做）

用 2–5 句业务语言说明：谁、遇到什么问题、这次交付后他们能做什么。

## 交付内容（做什么）

- 行为 1：……（对应 F- / BR- 编号）
- 行为 2：……

## 输入输出与错误状态

- 输入 / 输出（契约路径或函数签名）：……
- 错误与边界：外部失败、超时、重复执行、部分成功时的表现（要幂等、可重放）。
- 数据与事件所有权：本任务读写哪些 schema、发布 / 订阅哪些事件（只写自己模块的）。

## 明确不做

- ……（防止范围蔓延；写清楚留给哪个后续任务）

## 完成条件（本任务特有；通用的“完成的定义”见规则文件第 10 节）

- [ ] 上面 `verify` 里的命令全部通过，且 `make verify`（`scope: full`）回执绑定 PR 最终 SHA
- [ ] 本任务特有的完成条件：……（可观察、可复核；例如“暂停资讯后法规任务仍被领取并完成”）
- [ ] 契约哈希未过期；规格与模块 README 已同步；用户可见变化已附产品更新片段

## 验收要点（人读）

- [ ] ……（与 AC 条目对应，写可观察的结果，不写实现细节）
- [ ] 失败路径与重复执行的表现
- [ ] 人工下架、人工修订、暂停等人工决定不被覆盖（若相关）
- [ ] 业务线（`lane`）带在任务载荷、事件、回执与账本里（若相关）

## 交付记录（完成后填写；中断时随每个检查点更新，新会话据此接力）

- 分支 / PR：
- 验证回执（`make verify`，`scope: full`，绑定 PR 最终 SHA）：
- 完成产物：
- **未完成项 / 下一步**：
- 合并提交：
- 部署与读回（发布标识头）：
- 业务验收（谁、何时、在哪个环境、看到了什么；模板见 `acceptance-record.md`）：
- 遗留与新发现的风险：
