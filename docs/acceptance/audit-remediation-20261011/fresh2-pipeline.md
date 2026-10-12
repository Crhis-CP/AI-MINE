# 后台流水线独立行为核对

旧版本：`65d362407226da856f66477807c5437acf1af27b`；新版本：`6996788c58347fa2483edc8e7d9e916292b20885`。

本轮核对 35 项：保留 19 项、现规格明确改变 7 项、遗漏 6 项、证据不足 3 项。遗漏为 P1 1 项、P2 5 项。结论只针对固定提交的静态行为路径，不等于线上验收。

## 已确认遗漏

- **PIPE2-05 · P2 · 首次启用的成功预览 24 小时有效期**：新库成功预览查询只限制 status、config_hash、permission_version 和可选 id，没有 completed_at/created_at 时间条件；过期成功记录永久可用。旧库和现规格均有 24 小时门。
  - 触发：创建暂停来源，在当前配置和许可下成功预览；把该预览 completed_at 置于 25 小时前（或等待 25 小时），不修改配置及许可；调用 updateSource({patch:{enabled:true},version:当前版本})。静态路径将接受该成功记录并启用；旧 change_source_state 拒绝。
- **PIPE2-06 · P2 · 同一配置的重复预览请求复用在途任务**：旧 enqueue_source_preview 会查同源同修订的 queued/leased 任务并返回原 id；新 requestSourcePreview 每次插入预览，自增 id 又被用作 singletonKey，无法对同配置去重，表也无对应唯一约束。
  - 触发：同一来源、配置和许可不变，第一条预览尚未处理时连续两次调用 requestSourcePreview(sourceId,{},actor)。将得到不同 preview_id/job singletonKey；worker 可抓取两次。
- **PIPE2-09 · P1 · 单源暂停后在途无日期材料仍可写入**：新 collectSource 只在开始时检查 enabled。后续 upsertMaterial 的 enabled 检查藏在有 sourceDateObservation 才执行的 prepareDateMutation 内；Markdown 列表可产生只有 URL/title 的材料，最终通用锁只检查 archived，不检查 enabled，因此暂停后可继续入库并把 health 写成 ok。
  - 触发：已启用 web_list/Markdown 来源（如只产生标题链接、无 detail 日期），在列表 HTTP 请求发出后、响应前通过 updateSource 将 enabled=false；随后让请求返回一条新标题链接。upsertMaterial 无 sourceDateObservation，未核对 enabled，仍插入材料；recordSourceCollectionSuccess 仍更新 cursor/health。也可用空结果复现暂停后 checkpoint/health 被写为成功。
- **PIPE2-28 · P2 · 反馈截图真实格式与像素上限**：旧 screenshot_bytes 校验 magic、JPEG 结束和 PNG 像素尺寸。新 submitFeedback 只检查 MIME 字符串与字节数且允许 GIF，未检查 magic、空文件或像素尺寸，随后直接写文件。
  - 触发：携带新 Idempotency-Key，提交合法长度反馈及 screenshot.mime='image/png', data=Buffer.from('not an image')；或 MIME=image/gif 的 GIF。新路径会收件保存，旧 screenshot_bytes 返回 400。
- **PIPE2-29 · P2 · 反馈关联页面仅允许本站地址**：旧 receive_feedback 检查相对路径、本站 HTTPS 域名及禁止用户名密码；新仅 trim 后截断 500 字符，任意外站或其他协议字符串可存入反馈。
  - 触发：用新幂等键提交合法反馈，pageUrl='https://external.example/phish' 或 'javascript:alert(1)'。submitFeedback 无页面来源验证，记录成功；旧入口返回 invalid_page。
- **PIPE2-30 · P2 · 反馈客户端小时上限、全站日上限与跨进程保持**：旧收件事务更新数据库两类限流桶；新只保留单进程 Map 的 5 条/分钟，没有小时/全站日计数；API 公共读限流只覆盖 /api/v1 与 /api/v3，也不能补齐 feedback 的限制。
  - 触发：同一 ip/UA 在一分钟内提交 5 条不同键反馈，61 秒后在同一小时再提交第 6 条，新实现接受而旧实现拒绝；或重启进程后立即再次提交。多客户端同日超过 500 条也无全站桶阻断。

## 逐项核对

| 编号 | 行为 | 结论 |
|---|---|---|
| PIPE2-01 | 来源加入后保持草稿/暂停，成功预览后才启用 | 保留 |
| PIPE2-02 | 来源配置的乐观并发与审计 | 保留 |
| PIPE2-03 | 修改采集配置时旧配置继续供稿 | 明确改变 |
| PIPE2-04 | 预览只在 worker 执行并绑定配置和许可 | 保留 |
| PIPE2-05 | 首次启用的成功预览 24 小时有效期 | 遗漏 / P2 |
| PIPE2-06 | 同一配置的重复预览请求复用在途任务 | 遗漏 / P2 |
| PIPE2-07 | 来源归档为终态并挡住在途采集 | 保留 |
| PIPE2-08 | 非身份配置修改保留 checkpoint | 明确改变 |
| PIPE2-09 | 单源暂停后在途无日期材料仍可写入 | 遗漏 / P1 |
| PIPE2-10 | 同 URL 不同来源的材料身份隔离 | 保留 |
| PIPE2-11 | 资讯线与法规线的暂停隔离 | 明确改变 |
| PIPE2-12 | 材料/许可/用途变更后拒绝旧处理授权 | 保留 |
| PIPE2-13 | 来源加入时 Owner 声明许可和逐项收紧 | 明确改变 |
| PIPE2-14 | 模型接入只使用通过测试的当前配置 | 保留 |
| PIPE2-15 | 取消旧月度金额上限，保留用量预留与熔断 | 明确改变 |
| PIPE2-16 | 付费结果未知不能通过重试或换路由绕过 | 保留 |
| PIPE2-17 | 已收到的模型结果先保存，恢复复用而非重付 | 保留 |
| PIPE2-18 | 付费无效输出的有限重试和缺用量保护 | 保留 |
| PIPE2-19 | 人工修订先存草稿，确认后发布 | 保留 |
| PIPE2-20 | 人工修订历史与事实冲突核查 | 保留 |
| PIPE2-21 | 事件同事/后续关系必须有当前原文证据 | 保留 |
| PIPE2-22 | 事件/话题下架成员持续受控，归并不复活 | 保留 |
| PIPE2-23 | 恢复一个下架记录不解除其他独立下架 | 保留 |
| PIPE2-24 | 正文更正/下架后报告立即停止复用旧总结 | 保留 |
| PIPE2-25 | 报告结果提交绑定当前材料并保留历史修订 | 保留 |
| PIPE2-26 | 长时间停机后的报告补刊范围 | 证据不足 |
| PIPE2-27 | 反馈幂等提交和不同载荷冲突 | 明确改变 |
| PIPE2-28 | 反馈截图真实格式与像素上限 | 遗漏 / P2 |
| PIPE2-29 | 反馈关联页面仅允许本站地址 | 遗漏 / P2 |
| PIPE2-30 | 反馈客户端小时上限、全站日上限与跨进程保持 | 遗漏 / P2 |
| PIPE2-31 | 反馈处理后 180 天去标识及截图删除恢复 | 明确改变 |
| PIPE2-32 | 管理员重置/停用/权限变化撤销该账号会话 | 保留 |
| PIPE2-33 | 修改自己的密码核对旧凭据并全部登出 | 保留 |
| PIPE2-34 | 负责人忘记密码的固定恢复入口及单次临时口令 | 证据不足 |
| PIPE2-35 | 备份校验、隔离还原与失败恢复 | 证据不足 |

### PIPE2-01 来源加入后保持草稿/暂停，成功预览后才启用

- 预期：新增来源不能直接开始正常采集；至少取得一条有效预览后才允许启用。
- 结论：**保留**。旧库创建即 paused/draft，新库 createSource 同样强制 enabled=false；启用检查成功预览。有效期另见 PIPE2-05。
- 旧依据：[db/migrations/0010_source_operations.up.sql:64–74](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0010_source_operations.up.sql#L64-L74)（新增来源保存为 draft 且 paused=true）；[db/migrations/0010_source_operations.up.sql:100–105](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0010_source_operations.up.sql#L100-L105)（启用检查预览及样例）。
- 新依据：`packages/backend/src/admin/sources.ts:241–254@6996788`（新增强制暂停）；`packages/backend/src/admin/sources.ts:139–144@6996788`（启用须匹配成功预览）；`packages/backend/src/admin/source-previews.ts:93–97@6996788`（零样例不能成功）。

### PIPE2-02 来源配置的乐观并发与审计

- 预期：操作者基于过期版本保存时拒绝覆盖；有效改动记录操作人及前后状态。
- 结论：**保留**。两版都有提交时的版本比较和事务内审计；新库也对归档状态拒绝配置编辑。
- 旧依据：[db/migrations/0010_source_operations.up.sql:50–76](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0010_source_operations.up.sql#L50-L76)（expected revision 检查及审计）。
- 新依据：`packages/backend/src/admin/sources.ts:120–125@6996788`（事务锁及 updated_at 版本检查）；`packages/backend/src/admin/sources.ts:199–205@6996788`（前后值审计与公开投影重算）。

### PIPE2-03 修改采集配置时旧配置继续供稿

- 预期：影响采集的修改先存草稿，预览通过后显式激活；在此之前保留旧配置采集。
- 结论：**明确改变**。旧库每次保存把来源改为 draft/paused；新库独立保存配置草稿并返回 pending_config，符合新规格明确要求。
- 旧依据：[db/migrations/0010_source_operations.up.sql:60–73](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0010_source_operations.up.sql#L60-L73)（保存即修改配置并暂停）。
- 新依据：`packages/backend/src/admin/sources.ts:126–137@6996788`（激活与草稿分支）；`docs/01-product/04-private-operations.md:1158–1158@6996788`（OPQ-06：旧配置继续采集，DEC-57）。

### PIPE2-04 预览只在 worker 执行并绑定配置和许可

- 预期：HTTP 只提交预览任务；配置改变或归档后旧预览结果不得授权新配置；至少一个有效样例。
- 结论：**保留**。旧库 worker 检查配置修订及归档，新库在抓取前后核对许可版本、配置哈希和归档状态；未创建正文业务材料。重复排队另见 PIPE2-06。
- 旧依据：[services/live_pipeline/source_preview.py:6–23](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/source_preview.py#L6-L23)（worker 获取预览并拒绝过期来源）；[db/migrations/0028_source_preview_queue.up.sql:29–59](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0028_source_preview_queue.up.sql#L29-L59)（结束时再次核对配置和任务租约）。
- 新依据：`packages/backend/src/admin/source-previews.ts:34–57@6996788`（HTTP 入队）；`packages/backend/src/admin/source-previews.ts:60–100@6996788`（抓取前后版本、许可与样例检查）。

### PIPE2-05 首次启用的成功预览 24 小时有效期

- 预期：首次启用以及新配置激活时，成功预览必须在过去 24 小时内完成。
- 结论：**遗漏**。新库成功预览查询只限制 status、config_hash、permission_version 和可选 id，没有 completed_at/created_at 时间条件；过期成功记录永久可用。旧库和现规格均有 24 小时门。
- 旧依据：[db/migrations/0010_source_operations.up.sql:100–105](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0010_source_operations.up.sql#L100-L105)（previewed_at 必须不早于当前时间减 1 天）。
- 新依据：`packages/backend/src/admin/source-previews.ts:104–112@6996788`（查询没有时间条件）；`packages/backend/src/admin/sources.ts:126–144@6996788`（首次启用及激活均调用该查询）；`docs/01-product/04-private-operations.md:400–400@6996788`（首次启用明确 24 小时）。
- 可复现触发：创建暂停来源，在当前配置和许可下成功预览；把该预览 completed_at 置于 25 小时前（或等待 25 小时），不修改配置及许可；调用 updateSource({patch:{enabled:true},version:当前版本})。静态路径将接受该成功记录并启用；旧 change_source_state 拒绝。

### PIPE2-06 同一配置的重复预览请求复用在途任务

- 预期：同配置已有 queued/running 预览时，重复点击或请求重试应返回同一任务，不再次抓取。
- 结论：**遗漏**。旧 enqueue_source_preview 会查同源同修订的 queued/leased 任务并返回原 id；新 requestSourcePreview 每次插入预览，自增 id 又被用作 singletonKey，无法对同配置去重，表也无对应唯一约束。
- 旧依据：[db/migrations/0028_source_preview_queue.up.sql:16–24](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0028_source_preview_queue.up.sql#L16-L24)（同配置在途任务复用）。
- 新依据：`packages/backend/src/admin/source-previews.ts:40–56@6996788`（每次 INSERT 并以新 id 排队）；`database/migrations/sources/202610120040_source_previews.sql:6–10@6996788`（无同配置在途唯一约束）；`docs/01-product/02b-functional-specification.md:55–55@6996788`（每个配置版本只保留一个在途预览）。
- 可复现触发：同一来源、配置和许可不变，第一条预览尚未处理时连续两次调用 requestSourcePreview(sourceId,{},actor)。将得到不同 preview_id/job singletonKey；worker 可抓取两次。

### PIPE2-07 来源归档为终态并挡住在途采集

- 预期：归档来源不得恢复、再预览、立即采集或继续接纳在途结果；历史材料不因归档被删除。
- 结论：**保留**。旧库 archived 终态，新库多个入口显式拒绝，材料写入和成功 checkpoint 提交均检查 archived；归档不执行历史内容删除。
- 旧依据：[db/migrations/0010_source_operations.up.sql:97–108](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0010_source_operations.up.sql#L97-L108)（归档不能重新激活）；[services/live_pipeline/source_store.py:2333–2340](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/source_store.py#L2333-L2340)（非 active 不提交采集页）。
- 新依据：`packages/backend/src/admin/sources.ts:374–390@6996788`（归档写入屏障及归档动作）；`packages/backend/src/admin/sources.ts:124–124@6996788`（归档不能编辑）；`packages/backend/src/admin/source-previews.ts:41–43@6996788`（归档不能预览）；`packages/backend/src/content/materials.ts:131–135@6996788`（材料提交检查归档）。

### PIPE2-08 非身份配置修改保留 checkpoint

- 预期：修改名称、轮询和限额不把来源当新源重新回填；入口、身份和翻页规则改变才重置读取位置。
- 结论：**明确改变**。旧库通用 save_source_configuration 清空 cursor（个别受控修复另有保留）；新库仅在 checkpoint identity 变化时清空，符合来源配置修订的现行方向。
- 旧依据：[db/migrations/0010_source_operations.up.sql:62–73](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0010_source_operations.up.sql#L62-L73)（通用配置保存清空游标）；[db/migrations/0018_reviewed_source_scope.up.sql:69–69](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0018_reviewed_source_scope.up.sql#L69-L69)（特定许可升级保留旧游标）。
- 新依据：`packages/backend/src/admin/sources.ts:153–174@6996788`（只在 checkpoint identity 改变时重置）；`packages/backend/src/sources/directory-profile.ts:4–24@6996788`（identity 排除翻页上限和说明字段）。

### PIPE2-09 单源暂停后在途无日期材料仍可写入

- 预期：负责人暂停单个来源后，已发出请求返回的结果不得继续提交材料或推进 checkpoint；管理暂停优先。
- 结论：**遗漏**。新 collectSource 只在开始时检查 enabled。后续 upsertMaterial 的 enabled 检查藏在有 sourceDateObservation 才执行的 prepareDateMutation 内；Markdown 列表可产生只有 URL/title 的材料，最终通用锁只检查 archived，不检查 enabled，因此暂停后可继续入库并把 health 写成 ok。
- 旧依据：[services/live_pipeline/source_store.py:2324–2340](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/source_store.py#L2324-L2340)（页提交重新核对 active 和 paused）。
- 新依据：`packages/backend/src/sources/collect.ts:156–165@6996788`（仅入口检查 enabled）；`packages/backend/src/sources/web-list.ts:211–223@6996788`（Markdown 候选不带日期观察）；`packages/backend/src/content/date-evidence.ts:45–50@6996788`（无日期观察直接返回）；`packages/backend/src/content/materials.ts:121–138@6996788`（通用提交仅检查业务线和归档）；`packages/backend/src/admin/sources.ts:367–376@6996788`（成功 checkpoint 只校验未归档）；`packages/backend/src/sources/collect.ts:287–305@6996788`（材料与 checkpoint 后续提交）。
- 可复现触发：已启用 web_list/Markdown 来源（如只产生标题链接、无 detail 日期），在列表 HTTP 请求发出后、响应前通过 updateSource 将 enabled=false；随后让请求返回一条新标题链接。upsertMaterial 无 sourceDateObservation，未核对 enabled，仍插入材料；recordSourceCollectionSuccess 仍更新 cursor/health。也可用空结果复现暂停后 checkpoint/health 被写为成功。

### PIPE2-10 同 URL 不同来源的材料身份隔离

- 预期：两个不同来源采到同一 URL 时，分别保留来源身份；某源修订不得覆盖另一源记录。
- 结论：**保留**。旧 item id 包含 source id，新默认 URL identity 同样加 sourceId；兼容旧 identity 的查询也只认同源，异源不能改写。
- 旧依据：[services/live_pipeline/source_ingestion.py:276–303](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/source_ingestion.py#L276-L303)（source_item_id 由 source id 与外部身份共同构造）。
- 新依据：`packages/backend/src/content/materials.ts:109–114@6996788`（来源前缀身份）；`packages/backend/src/content/materials.ts:143–153@6996788`（兼容查询限定 source_id）；`packages/backend/src/content/materials.ts:190–198@6996788`（异来源只记录发现不修订）。

### PIPE2-11 资讯线与法规线的暂停隔离

- 预期：暂停资讯线时法规线继续；采集、处理及公开控制按业务线识别。
- 结论：**明确改变**。旧 processing_paused 是站点单值，新控制表按 lane/switch/holder 读取，运行材料验证 lane，符合现规格对旧共享暂停的明确修正。all 仍可作为显式批量作用域，不等于只剩一个全站开关。
- 旧依据：[services/live_pipeline/operations.py:1336–1360](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L1336-L1360)（旧站单一 processing_paused）。
- 新依据：`packages/backend/src/operations/lane-controls.ts:64–86@6996788`（按 lane 和阶段计算暂停）；`packages/backend/src/operations/lane-controls.ts:151–166@6996788`（Owner 可指定 lane）；`packages/backend/src/content/materials.ts:121–125@6996788`（材料控制作用域匹配）；`docs/01-product/04-private-operations.md:31–31@6996788`（明确拆分旧共享暂停）。

### PIPE2-12 材料/许可/用途变更后拒绝旧处理授权

- 预期：外部处理和公开用途按当前来源、材料修订、资源范围与许可校验；许可未知或被收紧不得沿用旧 allow。
- 结论：**保留**。旧正文处理绑定来源配置与权限 fingerprint，新 permit 逐项比较 source/lane/material/input/resource，重新读取现行 policy，变化即拒绝。该项只评价已接入 permit 的授权判定，不据此宣称全部采集入口均具备提交屏障。
- 旧依据：[services/live_pipeline/source_store.py:216–250](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/source_store.py#L216-L250)（配置、范围和权限指纹绑定）；[services/live_pipeline/operations.py:920–938](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L920-L938)（人工发布也校验许可和下架）。
- 新依据：`packages/backend/src/providers/permissions.ts:34–85@6996788`（材料与现行用途核验）；`packages/backend/src/sources/permission-store.ts:163–202@6996788`（未知、版本变化、范围或到期拒绝）。

### PIPE2-13 来源加入时 Owner 声明许可和逐项收紧

- 预期：按照 Owner 声明基线建档九项允许，保留版本、范围及收紧；站外全文再分发不自动放宽。
- 结论：**明确改变**。旧库需显式 licensed_text/public_full_text_allowed 才进入正文路径；新库按 Owner 声明生成九项用途版本，site_fulltext=false 时收紧公开正文/译文，正是 DEC-33 改变。
- 旧依据：[services/live_pipeline/source_store.py:224–235](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/source_store.py#L224-L235)（旧许可用途范围条件）。
- 新依据：`packages/backend/src/admin/sources.ts:255–283@6996788`（owner_declared 及初始用途）；`packages/backend/src/admin/sources.ts:176–197@6996788`（关闭全文产生许可新版本）；`docs/01-product/04-private-operations.md:410–413@6996788`（Owner 基线、九项、收紧与第十项边界）。

### PIPE2-14 模型接入只使用通过测试的当前配置

- 预期：配置/密钥更改后不得继续把旧测试当有效；未通过测试的接入不能用于自动任务。
- 结论：**保留**。旧 enable/assign 检查 tested；新运行时要求 passed_revision===revision，发送前 assertCurrent 又核对启用状态、修订和 secret_id；无明文进入安全 DTO 的路径。
- 旧依据：[services/live_pipeline/model_config.py:295–344](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/model_config.py#L295-L344)（启用及环节指派要求通过能力测试）；[services/live_pipeline/model_config.py:350–361](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/model_config.py#L350-L361)（安全输出排除密钥字段）；[services/live_pipeline/model_config.py:516–520](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/model_config.py#L516-L520)（密钥封装）。
- 新依据：`packages/backend/src/providers/model-registry.ts:61–103@6996788`（当前配置测试、解密只在发送端以及发送前复核）。

### PIPE2-15 取消旧月度金额上限，保留用量预留与熔断

- 预期：不因月累计金额到 100 元停工；继续按业务线记录 reserved/settled/unknown，达到提示步长仅通知。
- 结论：**明确改变**。旧预算表有写死金额 CHECK 和 reserve gate，新月度累计用于 usage_notice，明示不暂停；异常范围按 lane/capability，符合 Owner 新决定。
- 旧依据：[db/migrations/0008_live_pipeline.up.sql:89–94](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0008_live_pipeline.up.sql#L89-L94)（旧月度上限）；[db/migrations/0008_live_pipeline.up.sql:178–184](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0008_live_pipeline.up.sql#L178-L184)（超过上限拒绝预留）。
- 新依据：`packages/backend/src/providers/usage-protection.ts:154–165@6996788`（分线预留记账）；`packages/backend/src/providers/usage-protection.ts:326–350@6996788`（月累计提示不暂停）；`docs/02-rules/05-cost-and-budget.md:5–7@6996788`（Owner 取消月度金额上限）。

### PIPE2-16 付费结果未知不能通过重试或换路由绕过

- 预期：请求发出后超时/中断时保留 unknown，不自动重复付款；改请求标识、模型路由也不能洗掉该材料环节的未知账。
- 结论：**保留**。两版在调用前查询已有 unknown/in_progress；新库还按素材阶段扫描跨 logical key 未决账，异常记录 unknown，人工解除要求当前版本与未计费证据。
- 旧依据：[services/live_pipeline/model.py:774–799](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/model.py#L774-L799)（未知调用及同素材 stage 阻断）；[services/live_pipeline/store.py:627–648](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/store.py#L627-L648)（跨调用 key 查未决尝试）。
- 新依据：`packages/backend/src/providers/receipts.ts:201–216@6996788`（同新闻素材/能力跨 key 未决阻断）；`packages/backend/src/providers/receipts.ts:499–507@6996788`（pending 超时变 unknown）；`packages/backend/src/providers/receipts.ts:648–660@6996788`（未知异常不重发）；`packages/backend/src/admin/runs.ts:145–164@6996788`（人工核对版本和未计费，自动释放无效）。

### PIPE2-17 已收到的模型结果先保存，恢复复用而非重付

- 预期：供应商响应与用量先持久化；业务处理崩溃后复用同一响应，不重新购买。
- 结论：**保留**。旧 response receipt 在结算前持久化，新 paidRequest 在返回业务层前保存 attempt.response 和 response_attempt_id；已有 received/completed 直接复用并记复用次数。
- 旧依据：[services/live_pipeline/model.py:708–776](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/model.py#L708-L776)（命中已结算缓存直接返回）；[services/live_pipeline/model.py:925–935](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/model.py#L925-L935)（先记录 response receipt 再结算）。
- 新依据：`packages/backend/src/providers/receipts.ts:492–498@6996788`（已收到/完成直接复用）；`packages/backend/src/providers/receipts.ts:668–687@6996788`（物理尝试响应先落库再返回）。

### PIPE2-18 付费无效输出的有限重试和缺用量保护

- 预期：只有已证明用量的无效响应可有限重买；同一错误输出或缺计费证据不能无限重试。
- 结论：**保留**。旧最多两次安全重试，缺精确用量不授权重买；新非翻译能力总计最多三个有证明响应，缺用量复用旧失败；翻译另有次数、冷却及重复输出屏障。
- 旧依据：[services/live_pipeline/model_receipts.py:20–28](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/model_receipts.py#L20-L28)（两次重试上限）；[services/live_pipeline/model_receipts.py:184–208](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/model_receipts.py#L184-L208)（只有 exact_usage 输出失败可 retry）。
- 新依据：`packages/backend/src/providers/receipts.ts:524–559@6996788`（缺证明不重买、翻译冷却及三次有证明回答上限）。

### PIPE2-19 人工修订先存草稿，确认后发布

- 预期：保存人工草稿不改变公开内容；发布核对原材料修订、事实、原文依据，防止旧草稿覆盖新原文。
- 结论：**保留**。两版均绑定来源 revision 和人工版本；新 command!=publish 仅记草稿事件，发布需要双确认和现原文中至少 12 字逐字证据。
- 旧依据：[services/live_pipeline/operations.py:868–927](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L868-L927)（版本及确认门）；[services/live_pipeline/operations.py:954–975](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L954-L975)（原文证据与冲突门）。
- 新依据：`packages/backend/src/admin/content.ts:174–224@6996788`（草稿与发布命令分开，源修订及双确认）；`packages/backend/src/admin/content.ts:230–252@6996788`（发布生效记录不可变）。

### PIPE2-20 人工修订历史与事实冲突核查

- 预期：自动修订不得改写人工历史；来源更新后提示需复核，事实依据不再成立时要求新的核查说明和证据。
- 结论：**保留**。旧核查绑定人工/来源修订并要求真原文引文；新人工修订为追加记录，变化追加 needs_review/conflict 事件，发布 conflict 需处理说明。该项不把 AI 输出当人工金标。
- 旧依据：[services/live_pipeline/operations.py:1083–1142](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L1083-L1142)（不可用过期材料/修订核查冲突）。
- 新依据：`packages/backend/src/editorial/manual-revisions.ts:7–36@6996788`（追加冲突/待核对事件并保留历史）；`packages/backend/src/admin/content.ts:217–251@6996788`（证据及冲突说明门）。

### PIPE2-21 事件同事/后续关系必须有当前原文证据

- 预期：相同事件与后续进展分开；证据不在原文、阶段不符、来源修订过期时保持分开并重新判定。
- 结论：**保留**。旧 association 校验两侧原文引文、动作/阶段、源修订；新 validatedRelation 亦要求逐字引文和同法域主体动作，后续要求较新时间及实际变化；写入前重核材料修订和人工决定。
- 旧依据：[services/live_pipeline/event_association.py:197–220](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/event_association.py#L197-L220)（关系绑定源修订和输入）；[services/live_pipeline/event_association.py:489–528](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/event_association.py#L489-L528)（原文证据与动作/阶段区分）。
- 新依据：`packages/backend/src/events/relate.ts:81–110@6996788`（同事/后续证据门）；`packages/backend/src/events/group.ts:975–1003@6996788`（提交时复核材料和人工决定）。

### PIPE2-22 事件/话题下架成员持续受控，归并不复活

- 预期：下架时记住成员，后续归并、拆组和材料修订不得使被下架成员重新公开。
- 结论：**保留**。旧 withdrawal_memberships 保存根对象的历史成员；新 withdrawal_records 保存当时快照，publication.withdrawal_members 继续捕获后加入成员，归并时也 captureEventWithdrawal。
- 旧依据：[db/migrations/0013_persistent_withdrawal_membership.up.sql:1–33](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0013_persistent_withdrawal_membership.up.sql#L1-L33)（持久成员与有效下架视图）。
- 新依据：`packages/backend/src/editorial/withdrawals.ts:79–95@6996788`（记录成员快照）；`packages/backend/src/publication/withdrawals.ts:42–51@6996788`（记住新增成员并计算持有）；`packages/backend/src/events/merge.ts:21–43@6996788`（归并捕获下架关系）。

### PIPE2-23 恢复一个下架记录不解除其他独立下架

- 预期：多次/多层下架重叠时，只恢复明确选择的记录；仍有活动下架持有的材料继续隐藏。
- 结论：**保留**。旧 effective_item_withdrawals 由所有 active 根取并集；新恢复指定 withdrawalId，只将该投影 active=false，其他 active 记录仍挡住；确认前成员快照变化会拒绝。
- 旧依据：[db/migrations/0013_persistent_withdrawal_membership.up.sql:1–16](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0013_persistent_withdrawal_membership.up.sql#L1-L16)（独立根并集限制恢复）。
- 新依据：`packages/backend/src/editorial/withdrawals.ts:73–95@6996788`（快照版本及指定 id 恢复）；`packages/backend/src/publication/withdrawals.ts:31–50@6996788`（只关闭该 record，其他 active 保持）。

### PIPE2-24 正文更正/下架后报告立即停止复用旧总结

- 预期：已入报告的材料更正或撤回时，报告不得继续展示据旧内容生成的标题/综述；重新生成失败时保持可解释状态。
- 结论：**保留**。旧公共快照移除引用下架对象的报告；新编辑事务立即将受影响报告标 correctionPending 并持久排队，公开读层隐藏旧综合标题/导语，修复失败保留 failed，不编造已更正。
- 旧依据：[db/migrations/0013_persistent_withdrawal_membership.up.sql:55–80](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/db/migrations/0013_persistent_withdrawal_membership.up.sql#L55-L80)（报告及依赖资源按下架引用闭包过滤）。
- 新依据：`packages/backend/src/reports/corrections.ts:32–54@6996788`（同编辑事务使旧综合失效并排队）；`packages/backend/src/reports/corrections.ts:98–115@6996788`（失败留状态且可以继续恢复）；`packages/backend/src/publication/reports.ts:154–170@6996788`（修订待处理隐藏旧标题和导语）。

### PIPE2-25 报告结果提交绑定当前材料并保留历史修订

- 预期：生成期间材料/报告变更时不得用旧结果覆盖；成功更正产生新修订并保留前版。
- 结论：**保留**。旧 report lease 提交重新验证当前报告及所有材料 revision；新更正任务锁定公开引用、许可和报告 revision，任何变更返回 stale；写新版前保存 report_revisions。
- 旧依据：[services/live_pipeline/report_store.py:35–51](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/report_store.py#L35-L51)（报告当前材料绑定）；[services/live_pipeline/report_store.py:177–191](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/report_store.py#L177-L191)（过期租约与材料变化拒绝）。
- 新依据：`packages/backend/src/reports/corrections.ts:78–95@6996788`（当前材料、许可和版本校验及历史修订）；`packages/backend/src/reports/compose.ts:181–195@6996788`（替换前留原版）。

### PIPE2-26 长时间停机后的报告补刊范围

- 预期：漏发报告恢复时，须按当前产品规定的周期补齐，且不能覆盖已下架期次或把旧材料当新稿。
- 结论：**证据不足**。新库明确只回补最近 days（默认 7）日报、上一完整周和上一完整月；旧库存在修订构造和报告 worker，但本轮证据不足以确认旧实际自动补刊范围及新规则是否有意缩窄。不能把这个差异直接认定遗漏。
- 旧依据：[services/distribution_v2/reports.py:312–363](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/distribution_v2/reports.py#L312-L363)（已有证据不变复用/变化增修订）；[services/live_pipeline/worker.py:1131–1135](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/worker.py#L1131-L1135)（后台调报告 runner）。
- 新依据：`packages/backend/src/reports/compose.ts:410–451@6996788`（默认回补最近 7 日、上周和上月）。
- 尚需证据：需对产品指定的最长停机补刊窗口作确定裁决，或在隔离时钟中核对跨两周/两月恢复场景；本轮未执行。

### PIPE2-27 反馈幂等提交和不同载荷冲突

- 预期：同一提交标识重复提交返回原收件 ID；同标识不同内容拒绝。
- 结论：**明确改变**。旧每次 receive_feedback 生成 uuid 并插入；新以幂等键哈希锁和 payload_hash 持久去重，是现规格新增可靠性要求。
- 旧依据：[services/live_pipeline/operations.py:1213–1240](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L1213-L1240)（每次生成新 id 并插入）。
- 新依据：`packages/backend/src/operations/feedback.ts:58–83@6996788`（校验标识、锁及同键冲突）；`packages/backend/src/operations/feedback.ts:96–100@6996788`（收件记录及提交记录同事务）；`docs/01-product/03-reader-pages.md:808–813@6996788`（幂等提交要求）。

### PIPE2-28 反馈截图真实格式与像素上限

- 预期：仅接受真实 PNG/JPEG/WebP、非空且 ≤2MB，不能信任客户端 MIME；拒绝 GIF/伪图片及超大像素图片。
- 结论：**遗漏**。旧 screenshot_bytes 校验 magic、JPEG 结束和 PNG 像素尺寸。新 submitFeedback 只检查 MIME 字符串与字节数且允许 GIF，未检查 magic、空文件或像素尺寸，随后直接写文件。
- 旧依据：[services/live_pipeline/operations.py:477–519](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L477-L519)（真实文件格式、非空及 PNG 像素检查）。
- 新依据：`packages/backend/src/operations/feedback.ts:67–69@6996788`（只按客户端 MIME 与字节数，允许 gif）；`packages/backend/src/operations/feedback.ts:89–94@6996788`（未解码校验即存储）；`apps/api/src/routes/feedback.ts:20–35@6996788`（multipart/base64 直接传入字节）；`docs/01-product/03-reader-pages.md:806–812@6996788`（明确拒绝 GIF/伪图片，须像素上限）。
- 可复现触发：携带新 Idempotency-Key，提交合法长度反馈及 screenshot.mime='image/png', data=Buffer.from('not an image')；或 MIME=image/gif 的 GIF。新路径会收件保存，旧 screenshot_bytes 返回 400。

### PIPE2-29 反馈关联页面仅允许本站地址

- 预期：来源页只接受站内路径或本站 URL，并按现规格保留最多 2048 字符。
- 结论：**遗漏**。旧 receive_feedback 检查相对路径、本站 HTTPS 域名及禁止用户名密码；新仅 trim 后截断 500 字符，任意外站或其他协议字符串可存入反馈。
- 旧依据：[services/live_pipeline/operations.py:1195–1212](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L1195-L1212)（本站地址白名单）。
- 新依据：`packages/backend/src/operations/feedback.ts:64–66@6996788`（仅截断无 URL 校验）；`apps/api/src/routes/feedback.ts:22–35@6996788`（原样透传 pageUrl）；`docs/01-product/03-reader-pages.md:807–810@6996788`（仅本站地址及 2048 字符）。
- 可复现触发：用新幂等键提交合法反馈，pageUrl='https://external.example/phish' 或 'javascript:alert(1)'。submitFeedback 无页面来源验证，记录成功；旧入口返回 invalid_page。

### PIPE2-30 反馈客户端小时上限、全站日上限与跨进程保持

- 预期：每客户端每小时 5 条、全站每天 500 条的持久限流需要保留；重启服务或切换进程不能清空计数。
- 结论：**遗漏**。旧收件事务更新数据库两类限流桶；新只保留单进程 Map 的 5 条/分钟，没有小时/全站日计数；API 公共读限流只覆盖 /api/v1 与 /api/v3，也不能补齐 feedback 的限制。
- 旧依据：[services/live_pipeline/operations.py:1215–1231](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L1215-L1231)（持久客户端小时桶和全站日桶）。
- 新依据：`packages/backend/src/operations/feedback.ts:38–45@6996788`（只在内存保留每分钟 5 条）；`packages/backend/src/operations/feedback.ts:84–87@6996788`（收件只调用该限流）；`apps/api/src/app.ts:57–70@6996788`（公共读限流不覆盖 feedback）；`docs/01-product/03-reader-pages.md:811–811@6996788`（保留旧限流值并可配置）。
- 可复现触发：同一 ip/UA 在一分钟内提交 5 条不同键反馈，61 秒后在同一小时再提交第 6 条，新实现接受而旧实现拒绝；或重启进程后立即再次提交。多客户端同日超过 500 条也无全站桶阻断。

### PIPE2-31 反馈处理后 180 天去标识及截图删除恢复

- 预期：处理完成后 180 天删联系方式和截图，保留去标识正文与处理记录；文件删除失败可继续清理且不误删仍使用的共享截图。
- 结论：**明确改变**。旧只有三态、备注和私有截图读取；新记录 completed_at，清理时先持久记录删除任务再去标识，文件删除前检查其他记录引用；满足新增 DEC-46。
- 旧依据：[services/live_pipeline/operations.py:1242–1294](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/live_pipeline/operations.py#L1242-L1294)（旧私有反馈状态/截图接口）。
- 新依据：`packages/backend/src/admin/feedback.ts:38–49@6996788`（完成时间随状态变化）；`packages/backend/src/admin/feedback.ts:99–126@6996788`（180 天去标识及耐失败文件清理）；`docs/01-product/04-private-operations.md:788–788@6996788`（180 天新增规则）。

### PIPE2-32 管理员重置/停用/权限变化撤销该账号会话

- 预期：只有负责人能管理管理员；重置、停用及权限变化使该账号既有会话失效，不处理 worker/reader 等独立服务身份。
- 结论：**保留**。旧按 account_id 撤销 sessions；新按 user_id 删除 admin_sessions，并更新 account access revision；拒绝对 Owner 或操作者自身做管理员管理动作。
- 旧依据：[services/admin/password_accounts.py:435–489](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/admin/password_accounts.py#L435-L489)（负责人、目标账号和会话撤销）；[services/admin/password_accounts.py:493–518](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/admin/password_accounts.py#L493-L518)（启停撤销目标会话）。
- 新依据：`packages/backend/src/admin/accounts.ts:110–144@6996788`（当前授权/版本检查及按 user_id 撤销）。

### PIPE2-33 修改自己的密码核对旧凭据并全部登出

- 预期：自身改密须证明旧密码；并发凭据变化必须失败；成功后旧会话全部撤销。
- 结论：**保留**。旧事务内复核旧密码快照与当前会话后更新 session_epoch；新先验证旧密码，事务内再核对 access/credential revision，更新密码并清空该用户全部 admin_sessions。
- 旧依据：[services/admin/password_accounts.py:408–455](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/admin/password_accounts.py#L408-L455)（核旧密码、复核快照、撤销）。
- 新依据：`packages/backend/src/admin/accounts.ts:209–234@6996788`（旧密码及双版本检查，改密后全部登出）。

### PIPE2-34 负责人忘记密码的固定恢复入口及单次临时口令

- 预期：Owner 无法登录时，通过预置固定恢复入口取得一次性 15 分钟口令，撤销会话、清登录限流、告警并首次强制改密。
- 结论：**证据不足**。新库 recoverOwnerPassword 的代码行为齐全；但本轮未读取现存秘密、未进入云控制台，也没有旧库同等固定命令与实际注册入口的完整证据，因此不能确认最终可由 Owner 操作的恢复链已保留/落实。
- 旧依据：[services/admin/password_accounts.py:408–455](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/services/admin/password_accounts.py#L408-L455)（旧在线改密必须有已认证会话，不能证明失联恢复入口）。
- 新依据：`packages/backend/src/admin/accounts.ts:265–284@6996788`（15 分钟单次口令、撤会话、清限流、告警）；`packages/backend/src/admin/accounts.ts:193–205@6996788`（一次性有效期及强制改密路由）；`docs/01-product/04-private-operations.md:1126–1126@6996788`（Owner 固定恢复脚本要求）。
- 尚需证据：核对不含秘密的固定云命令注册清单，并由 Owner 在授权隔离恢复演练中验证；未把缺少演练测试写成代码功能遗漏。

### PIPE2-35 备份校验、隔离还原与失败恢复

- 预期：备份成功必须证明对象上传成功；灾难恢复能校验制品并在隔离库验证内容完整性，再按显式控制恢复。
- 结论：**证据不足**。旧有校验和/解密/隔离库还原及公开指针完整性脚本；新 runBackup 有 pg_restore --list、上传及失败标记，本地发布演练有回滚逻辑，但本轮未找到并核实与旧同等的实际生产恢复入口及隔离还原证据。不能用备份或本地镜像回滚代码存在推定灾备可恢复。
- 旧依据：[infra/tencent-cloud/scripts/restore_postgres.sh:81–106](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/infra/tencent-cloud/scripts/restore_postgres.sh#L81-L106)（校验和、解密与只读验证）；[infra/tencent-cloud/scripts/restore_postgres.sh:109–178](https://github.com/Crhis-CP/global-mining-policy-intelligence/blob/65d362407226da856f66477807c5437acf1af27b/infra/tencent-cloud/scripts/restore_postgres.sh#L109-L178)（隔离还原及公开数据完整性检查）。
- 新依据：`packages/backend/src/operations/backup.ts:119–149@6996788`（dump 格式检查及文件打包失败处理）；`packages/backend/src/operations/backup.ts:151–180@6996788`（上传结果、失败标识及保留）；`deploy/local-release.ts:27–54@6996788`（本地候选失败回滚演练）。
- 尚需证据：需要当前部署方受控恢复手册/脚本及隔离还原回执；不读取生产凭据，不执行生产恢复。

## 范围与限制

- 仅按固定提交核对可观察行为、失败恢复、人工优先与权限，不评价框架或代码风格。
- 旧源码只通过 gh api 在线读取到工具输出/进程内存，没有 clone、保存旧源码或迁移数据。
- 未读取本目录既有审计或开发交付结论；只创建本轮 fresh2-pipeline 文件。
- 所有 preserved 均为静态功能路径结论，不表示生产上线、模型内容质量或浏览器实测通过。
- 遗漏的触发场景来自控制流与表约束核对；未调用真实模型、未读取生产秘密、未向外发送消息。
- 本轮没有接触生产数据库或生成实际来源/反馈数据。
- 部分旧行为只存在于源码模块；不推定旧生产是否启用该路径。
- 长时间补刊、Owner 控制台恢复入口、生产隔离还原列为 uncertain，未因缺少测试或交付报告判遗漏。
- 范围固定为后台流水线；读者页面和法规专业处理由其他独立审计覆盖。
