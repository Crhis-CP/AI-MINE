# ADR-0014：轻量治理——统一验证入口代替人工仪式

- 状态：【设计】工程基线提案。“不依赖 GitHub Actions；PR-only、线性历史、可信制品、回退保留”为【Owner 决定】（旧ADR-0038，2026-09-26），见 ADR-0017。
- 类别：工程基线
- 关联：`06-agents/01-parallel-development-rules.md`、PIT（治理与流程）、ADR-0017；对应 B：`B:architecture/03-stack-decisions.md` ADR-N12

## 背景

旧项目依赖“00 总控”逐项人工审查、merge-order、任务边界文档、两阶段知识收口门、README 状态叙事等流程，文档与约束持续膨胀，迭代变慢，但巨型快照、信源接入停滞、离线规则包空转等问题没有被流程挡住。Owner 多次表达“轻量、不要过度优化”（08-owner-voice OWN-11、OWN-13、ANTI-16）。

## 决定

1. 能自动检查的规则一律写进仓库受跟踪的统一验证入口，分两档：`make verify`（每次合并前必跑：格式、类型、边界、数据归属、契约漂移、迁移只增、按角色配置校验、密钥扫描、依赖审计、单元与集成测试、产品更新片段、文档链接）与 `make release-check`（发布前必跑：制品构建、镜像基础层扫描、SBOM、签名、容量与冒烟）；密钥扫描、依赖审计、SBOM 的工具与范围见 `02-tech-stack.md` 7.2，结果写入验证回执。执行者与回执规则见 ADR-0017；不绑定任何托管 CI 平台。
2. 人工参与只保留：Owner 的产品决策与业务验收、Q 卡片裁决、授权边界清单中列明的高风险操作确认、非作者审查。
3. README 与 AGENTS.md 不写状态叙事；状态来自产品更新日志、部署记录（含外部读回的发布标识）、告警记录与只读 MCP。
4. 功能状态统一为 B 包六态：`specified → implemented → locally_verified → integrated → live_verified → quality_accepted`；与 A 包五态对应：规划中=specified、开发中=implemented、已合并=integrated、已上线=live_verified、已验收=quality_accepted（D16-quality-016）。`live_verified`、`quality_accepted` 必须链接证据。

## 后果

规则由机器执行、人只做决定；验证不因某个平台停用而中断；检查项少而稳定，单次执行成本可控（ADR-0015 只保留最小工具集）。
