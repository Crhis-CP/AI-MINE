# ADR-0017：不依赖 GitHub Actions 的验证与交付【新增】

- 状态：【Owner 决定】已接受——承接旧ADR-0038（Owner 2026-09-26 批准：“GitHub Actions 如果不是必须，以后不用”；PR-only、线性历史、版本绑定、可信制品、授权和回退不取消；`docs/architecture/decisions/0038-provider-independent-delivery.md:3-47@policy`）。验证入口、回执、信任根与部署授权的具体做法为【设计】工程基线（裁决 DEC-17；D12-architecture-011、D15-secops-004）。
- 2026-10-03 更新（GitHub Actions；08-owner-voice DEC-25 ③，TASK-0015）：
  - Owner 决定使用 GitHub Actions：新仓库是公开仓库（2026-10-03 读回），GitHub 托管的 runner 对公开仓库不计费。按“推翻条件”，它只作为第 3 条里的一个执行者：工作流 `.github/workflows/verify.yml` 跑的就是 `make verify`，同一套阶段、同一份回执，形状由 `make verify` 的 `toolchain` 阶段核对；其余条款不变（M0 期间有一个例外，见下面“Actions 不可用时”），生产照旧不依赖 Actions（第 10 条）。
  - 第 9 条“启用 GitHub Actions”的授权，范围与前提：公开仓库、不计费、只此一个工作流、不设必过检查（分支保护仍是 `06-agents/01-parallel-development-rules.md` 8.5 的 A 阶段，合并核对回执）。注册 runner、检查发布用的 GitHub App、别的工作流仍须 Owner 逐项授权。确认记录：Owner 的原话登记在 08-owner-voice DEC-25 ③ 与 `08-open-questions.md` 表四“Q-13 追加”，TASK-0015 的交付记录引用它。
  - 前提失效时：改仓库可见性之前先问 Owner；改成私有后作业自动跳过（作业带“只在公开仓库上跑”的条件），这个工作流不再算已授权的执行者，直到 Owner 重新确认。
  - Actions 不可用时：M0 期间沿用 08-owner-voice DEC-24 ②（Owner 2026-10-02 选“你直接合并”，提问时已说明回执缺容器整站检查）：云端容器的 `scope: focused` 回执通过、独立审查没有阻断项即可合并，PR 评论写明缺 `compose-smoke` 及原因，Actions 恢复后在 main 的头上补出 `scope: full` 回执。这是第 3 条“不跳过检查”与规则文件 8.3、AC-M0-08“`scope: focused` 回执不得用于合并”在 M0 期间的例外；M0 之后没有这个例外，等 Actions 恢复。要不要另备一个不依赖 GitHub、能跑 `compose-smoke` 的执行器，M0 退出前以 Q 卡片请 Owner 定（TASK-0015“退路”一节）。
  - 第 2 条的“私有日志”：在公开仓库的 Actions 上跑时，运行日志随仓库公开，失败阶段的整段日志也一样（`scripts/verify/README.md` 第 7 节）。工作流不用任何密钥，`make verify` 的各阶段拿不到真实凭据；回执里照旧只放日志摘要。
- 类别：Owner 决定（产品层）+ 工程落地
- 取代：ADR-0012 原第 2 条（构建执行器）；A 包 `06-agents/01-parallel-development-rules.md` §6/§8 中“合并队列、常驻 CI、合并后自动部署”的执行假设
- 关联：ADR-0012、ADR-0014、`07-deployment-and-ops.md`（第 3 节发布流程）、`06-agents/01-parallel-development-rules.md` 第 8 节；对应 B：`B:architecture/03-stack-decisions.md`（构建与发布行）、`B:delivery/02-implementation-roadmap.md` M5；验收 T-085、T-149、AC-OPS-06

## 背景

多 Agent 并行开发最依赖“合并前有人按同一标准验证”。停用 Actions 后，若不写明谁在什么时候对哪个 SHA 跑哪条命令、结果怎样留证，要么检查被悄悄跳过，要么每个 Agent 各跑各的。旧签名校验硬绑定 Actions OIDC；旧发布需串行锁与至少 1024MiB 可用内存、3GiB 磁盘，小主机上现场构建不可取（`docs/policy-upgrade/delivery-audit.md:19,147@policy`）。

## 决定

1. **唯一验证入口**：仓库提供受跟踪、版本化的 `make verify`（合并前）与 `make release-check`（发布前）。执行时显式绑定完整 Git SHA，在干净检出上运行；首尾校验 HEAD、tree、已跟踪与未跟踪文件状态、锁文件；拒绝替换对象、隐藏修改、错误提交、中断和漂移。不得把假目标或部分检查记成完整通过。
2. **验证回执**：机器可读 JSON，含 SHA、tree、锁文件哈希、各阶段结果、退出状态、失败阶段、OS/架构/工具版本、时间、私有日志摘要；不含环境变量、凭据、个人路径。回执随 PR 附上。无签名回执只是执行记录，不构成生产信任。
3. **执行者**：任一独立构建机或开发机上的隔离环境；**不得是生产主机**。ARM 本地验证与 Linux AMD64 生产制品核验分开，不由宿主机测试推断镜像架构正确。执行器不可用时换执行器，不跳过检查。
4. **合并规则**：PR-only；squash 合并保持线性历史；禁止强推与删除主分支；审查意见须解决；管理员同样受约束。合并前必须有该 PR **最终 SHA** 的通过回执。不删除必需检查来掩盖未执行的验证，不手工填成功。
5. **制品**：镜像按 SHA 构建（linux/amd64），附 manifest（镜像 digest 清单）、SBOM 与离线签名；签名绑定仓库、目的、提交/tree、manifest、通过的验证回执与平台。checksum 不能替代签名，签名也不能替代构建与内容验收。
6. **信任根**：Owner 一次性授权生成离线签名密钥（或选定独立签名服务），公钥指纹经受保护通道装到主机 root 专属路径；主机只接受该公钥签名的制品；候选制品不得自带验证器或信任配置。更换信任根必须在 Owner 明确授权的迁移中验证，**不能先关闭验签来上线**。
7. **传输与云身份**：生产主机只持镜像仓库的只读拉取令牌，按 digest 拉取，不按可变 tag；部署命令经云主机的固定命令通道与短期凭据下发（角色由 Owner 创建，最小权限）；禁止长期 AccessKey。
8. **合并后不自动部署**：部署是独立、可回退的操作，流程与“回滚也要验收”见 ADR-0012 第 3 条；公开响应带发布标识头，以外部读回该头作为“已上线”证据（验证通过 ≠ 已上线）。
9. **授权边界**：预先授权——隔离环境运行验证、只读检查、可逆发布、回滚；须 Owner 逐项明确授权——生产首次部署与切换、开放公网入口、DNS/域名/备案操作、创建或轮换凭据与签名密钥、采购或扩容云资源、数据库恢复、不可逆删除、启用 GitHub Actions 或注册 runner、修改分支保护。确认记录写入回执。
10. **生产不依赖交付链**：采集、加工、发布在服务器上持续运行；验证执行器、构建机或代码托管平台不可用只影响软件发布。

## 后果

- 规则不变、执行者可替换；每次合并与发布都有可重放、可签名的证据；
- 需要 Owner 一次性参与信任根设定与云角色创建，此后日常无需介入；
- 旧部署器与信任锚在新链路演练通过前保留作回退。

## 推翻条件

无（Owner 决定）。若 Owner 以后重新启用某托管 CI，它只作为第 3 条中的“一个执行者”，本 ADR 其余条款不变。
