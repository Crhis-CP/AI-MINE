# 新 AI矿策数据模型与所有权

状态：建议基线 v1.0；这是新系统逻辑设计，不是旧表复制、生产迁移脚本或已经实现的数据库。需求语义以产品目录为准；字段与模块边界在实施第一阶段形成冻结版本。旧库只由迁移适配器读取。

## 1. 建模原则

一个来源稿可以有多个修订，一篇来源稿可以涉及多个事件，一个事件可以有多个来源稿；事件进展不是重复抓取。一项政策可以关联多次出台、修订、暂停、废止事件。页面视图不反过来决定事实表结构。

业务身份使用无语义 UUID，版本使用单调整数，时间使用 UTC instant + 独立来源时间声明。不得从 URL 或标题重新生成实体 ID，重命名、换网址、翻译和更正保留身份。外部规范 URL、原始 URL、重定向后的 URL分别保存；URL 去重规则按版本记录。

PostgreSQL 为业务事实源；对象存储保存获准的较大材料与派生物；搜索、向量、公共 DTO 是可重建投影。队列表不承担业务状态唯一记录。公开查询只能读取已发布投影及当前抑制状态。

## 2. 模块与写入所有权

| 模块 | 自有 schema/聚合 | 可读接口 | 禁止 |
|---|---|---|---|
| source-control | source.* | SourcePolicyPort、SourceCatalogPort | 消费者直接修改来源启停/许可 |
| acquisition | acquisition.* | SourcePolicyPort、ArtifactPort | 抓取进程持有发布/审稿权限 |
| content | content.* | AcquisitionResult、SourcePolicyPort | 用翻译覆盖原材料修订 |
| intelligence | intelligence.* | ContentRevisionPort、EntityPort | 将模型 JSON 直接作为公开记录 |
| editorial | editorial.* | IntelligenceResultPort | 改写来源材料、账本或人工结论 |
| publication | publication.* | ApprovedProjectionInputPort | 读取任意私有表拼接 API |
| model-gateway | model.* | BudgetPolicyPort、ArtifactPort | 领域模块直接读密钥/调用厂商 |
| identity/audit | identity.*、audit.* | AuthorizationPort、AuditPort | 在普通业务代码使用 DB owner |
| feedback | feedback.* | PublicReferencePort、AuditPort | 接受截图URL后由服务器任意抓取 |

schema 名是推荐命名；模块分工不是每张表一个微服务。首期允许一个后端部署单元内以端口调用；同库跨模块写操作只能经所属模块 UnitOfWork 组合，不开放通配 SQL 工具。数据库层限制公开角色和高风险写角色，代码依赖检查限制模块内部引用。

## 3. 核心数据字典

以下 `id`、`created_at`、`revision` 为公共约定；`?` 表示可空，空值必须有业务原因，不能用空串或 1970 日期代替。规范字段优先普通列，JSONB 仅用于有 schema 的版本化明细。

| 对象 | 关键字段 / 约束 | 写入方与生命周期 |
|---|---|---|
| SourceObservation | original_row_id、workbook/sheet/row、original_url、target_id?、resolution、reason | source-control；保留原始321行及去重映射，不能因为目标合并丢原行 |
| Source | id、publisher_id、name、country_of_publisher、language[]、timezone?、settings_version | source-control；发布身份独立于news/policy的profile；身份撤销可影响全source，普通暂停仅影响所选profile |
| Publisher | id、canonical_name、editorial_family_id、ownership_evidence、verified_at | source-control；不同feed不等于独立发布方 |
| AcquisitionProfile | id、source_id、lane、version、state、health、entrypoints、parser_version、limits、cadence、credential_ref? | source-control；管理态draft/active/paused/archived，健康态另列；每lane独立启停；凭证只存引用，精确绑定主机/媒体类型/跳转策略 |
| SourcePolicy | source_id、version、fetch/internal_process/retain/external_model/public_excerpt/public_fulltext/public_translation各自许可、scope、evidence_ref、expires_at? | source-control；未知默认不授予相应能力；新版本不改旧证据 |
| FetchRun | id、source_id、profile_version、policy_version、scheduled_for、started/finished_at、outcome、http_status?、cursor_checkpoint、counters | acquisition；成功/无变化/部分/失败/受限分开 |
| SourceItem | id、source_id、external_id?、canonical_url、first_seen_at、latest_revision_id | acquisition/content交接；unique(source_id, external_id) 或规范URL索引；人工更名不改ID |
| DocumentRevision | id、item_id、revision_no、source_version?、content_hash、fetched_at、title_original、language、time_assertions、raw_artifact_id?、body_status、extraction_version、policy_version | content；append-only，unique(item_id, revision_no)；hash只复用内容对象，恢复旧文本/状态也记录新修订，不以历史hash唯一性吞掉法规变化 |
| ContentBlock | revision_id、block_id、order、kind、text/runs/table_cells、locator | content；段落/标题/列表/表格/引用；保留脚注、否定词、链接文本与顺序 |
| Attachment | revision_id、url、media_type、status、artifact_id?、rights_basis | content；unfetched不得计入正文完整率，附件不能自动递归抓取 |
| Translation | id、revision_id、target_language、glossary_version、input_hash、status、block_count、completed_count | content；完整性由全部块覆盖判定，unique(revision_id,target_language,recipe_version) |
| TranslationSegment | translation_id、block_id、input_hash、output、invocation_id?、state | content；已成功片段复用，不因任务重启重新付费 |
| Entity | id、type、canonical_name、jurisdiction?、verified_zh_name?、identifiers、status | intelligence；企业/机关/项目/矿山/矿种/地点分别建模 |
| EntityAlias | entity_id、name、language、scope、evidence_id、valid_from/to? | intelligence；同名不同国不自动合并，译名无证据时保留原名 |
| EntityMention | revision_id、block_id、offset、entity_id?、surface、resolution_state | intelligence；unresolved保留原文，不能猜测公司背景 |
| Claim | id、revision_id、claim_type、subject/action/object、jurisdiction、event_time、modality、status、quantity? | intelligence；asserted/denied/conditional/disputed，事实与分析分别标注 |
| EvidenceLink | claim_id、document_revision_id、block_id、start/end?、locator、relation、source_role、independence_family_id | intelligence；supports/contradicts/context，证据定位版本不可漂移 |
| Event | id、event_type、identity_key、current_revision_id、state | intelligence；单一实质事实变化；identity_key含主体/动作/对象/法域/时间和版本 |
| EventRevision | event_id、revision_no、claims[]、entity_refs[]、stage、certainty、evidence_status | intelligence；修订不覆盖旧公开事实 |
| EventMembership | event_id、item_revision_id、relation、decision_origin、locked_by_review? | intelligence；同事件/转载/背景/反证独立分类，人工锁不得被批处理覆盖 |
| EventRelation | from_event_id、to_event_id、type、evidence_ids、decision_version | intelligence；updates/corrects/repeals/implements/related，related不得显示为“后续进展” |
| Story / PolicyThread | id、type、title、event_memberships、relation_evidence、current_revision | intelligence；长期事项串联多个事件，主题相似不等于同Story；可以由版本化关系视图实现，不强迫再造聚簇引擎 |
| PolicyInstrument | id、jurisdiction_path、authority_id、instrument_number、legal_rank、official_url | intelligence；语言不是文书唯一身份，同编号不同机关/年份/法域不能碰撞 |
| PolicyVersion | instrument_id、version、promulgated/registered/published/effective/expiry时间声明、legal_status、amends/repeals引用 | intelligence；草案/公布/条件生效/有效/暂停/废止/未知分开，复杂条件原文保留 |
| PolicyExpression | id、policy_version_id、language、kind、document_revision_id、translation_id?、relationship_evidence | content/intelligence交接；同一法定版本的原语言/官方译文/AI译文分别定位，不把全站publication版本当法定版本 |
| PolicyInterpretation | id、policy_version_id、change_summary、scope、obligations、exceptions、deadlines、uncertainties、evidence_links | intelligence；读者可核对每一结论，关键字段缺失不自动填充 |
| ImpactAssessment | id、subject_ref、affected_scenarios、mechanism、direction、horizon、magnitude?、assumptions、evidence、basis_version | intelligence；法律要求/经营判断分栏，缺适用性信息不能写“必然违法/受益” |
| EditorialAssessment | subject_ref、version、Q/I/E/H独立结果、reasons、selection_state、ruleset_version | editorial；评分不作为全部动态准入门，算法版本保留 |
| ReviewDecision | id、subject_type/id/revision、actor_id、decision、field_patch、reason、previous_decision_id?、idempotency_key | editorial；append-only，真实人提交才为human，不冒充金标 |
| Suppression | subject_ref、scope、reason、actor_id、active、revision | editorial；优先于任何历史publication，明确恢复才取消 |
| Publication | id、generation、created_at、activated_at?、manifest_hash、status、policy_epoch | publication；构建/验证/激活/撤回，原子切换一个current指针 |
| PublicItemProjection | publication_id、item_id、item_revision_id、event_refs、中文阅读/原文许可视图、public timestamps | publication；强制白名单，不含模型/成本/队列/私有证据 |
| Topic | id、type、title、query_spec、description、revision | editorial；国家/矿种/公司/政策主题可独立投影 |
| ReportEdition | id、kind、period_start/end、timezone、edition_no、issued_at、publication_id、correction_of? | publication；历史不原地重写，有更正版本与撤下占位 |
| ModelInvocation | id、task_id、input_fingerprint、recipe_version、provider_request_id?、state、reserved/settled_cost、currency、usage?、result_ref? | model-gateway；unknown成本不清零、不换身份重复请求 |
| BudgetLedgerEntry | id、budget_id、invocation_id、entry_type、amount_decimal、currency、period、created_at | model-gateway；reserve/settle/release/adjust，金额NUMERIC，不用float |
| JobExecution | job_id、stage、subject_revision、recipe_version、idempotency_key、lease_token、attempt、checkpoint、state | 所属模块；队列只是投递器，业务execution有唯一键 |
| OutboxEvent / InboxReceipt | event_id、aggregate_id/version、event_type、schema_version、payload、published_at? / consumer、event_id | 生产方/消费方；事务写outbox，unique(consumer,event_id)阻止重复效果 |
| AuditEntry | id、actor、action、target_revision、before/after_digest、reason、request_id、at | audit；内容变更和审计同事务或可靠outbox，不记录密钥/原始正文 |
| ProductUpdate | id、release_id、change_id、category、title、paragraphs、published_at、time_precision | publication；健康软件版本登记后可见，新闻批次不生成更新日志 |
| Feedback | id、public_reference?、text、attachment_refs、created_at、status | feedback；独立收件，不开放公共内容写权限 |

## 4. 时间、金额与证据的精确定义

TimeAssertion 为 `{raw, local_date, local_time?, timezone?, utc?, precision, meaning, basis}`。只知日期时 `utc=null`，排序使用单独的稳定排序键，页面不能把排序键当来源时间。`meaning` 包含 published/updated/signed/registered/effective/event/discovered；来源更新和本站入库不能替代新闻发布时间。法律条件生效可有 `condition_text` 和证据定位，不能硬转一个不存在的 instant。报表按 Asia/Shanghai 的半开区间 `[start,end)` 统计。

Quantity 为 `{raw, value_decimal?, lower?, upper?, unit?, currency?, scale?, basis?, as_of?}`。百分比与百分点不同；资源量、储量、矿石量、金属含量、年产能、实际产量不能互换。汇率换算保存日期、数据源、舍入规则，不覆盖来源原值。

证据可以指向获准内部保存材料的块，也可以只指向来源URL、文号和合法短摘录。没有存储许可不意味着能把原文私藏到日志/embedding/缓存。公开证据展示再次经过public policy投影。

## 5. 唯一性、事务与版本

1. 来源profile编辑使用`expected_version`，预览任务绑定profile/policy版本；预览期间暂停再启用也递增settings_version，不能被旧任务自动启用。
2. 新材料修订、解析结果与阶段成功标记在一个事务提交；外部对象先写staging，DB引用后由回收器清理未被引用对象。不可把对象上传成功当业务提交成功。
3. 模型预算预留使用行锁/可串行化事务；余额 = limit − settled − outstanding_reserved。相同业务key不能并发重复预留。硬停不影响已有公开只读和确定性处理。
4. 发布构建冻结依赖revision集合；校验manifest、许可epoch、抑制epoch后CAS激活。读请求一次解析版本并贯穿搜索、列表、详情与分页。
5. 下架以当前抑制层覆盖已缓存历史投影，撤销CDN/服务缓存；无法确认当前抑制状态时停止返回可能被撤回的内容。旧日报显示撤下占位与更正，不恢复正文。
6. 审稿使用If-Match/expected_revision；版本变动返回409，保留用户草稿供重新核对。重复幂等key同payload返回原结果，异payload为409；不得把数据库故障当审核拒绝。

## 6. 索引与保留

初始索引：SourceItem(source_id,external_id/canonical_url_hash)、DocumentRevision(item_id,revision_no)、Claim(revision_id)、EvidenceLink(claim_id)、EventMembership(item_revision_id,event_id)、EventRelation(from,to,type)、Publication(generation)、PublicItemProjection(publication_id,sort_key,id)、JobExecution(state,next_run_at)、ModelInvocation(input_fingerprint,recipe_version)、InboxReceipt(consumer,event_id)。全文/向量索引是有界候选生成，不直接判定相同事件。

来源正文/原始快照按逐源到期政策删除；派生翻译、embedding、缓存同时失效或重审。账本、审核、下架记录保留其审计所需最小字段。公共edition保留引用和更正历史，避免每次发布复制全库正文；使用结构共享与引用计数。初始容量基准必须测增长率、索引写放大和回收效果。

## 7. 数据迁移交接

迁移资产包括来源原始行映射、合法材料、稳定公开URL/ID别名、人工修改/下架、已结费用/未知预留、发布历史。新系统不需要兼容旧表或旧运行栈。迁移器输出逐表/逐对象 reconciliation：输入数、成功数、隔离数、重复数、拒绝原因、内容hash、关联完整率。只读抽取、影子导入、结果对照、delta追平、切换、回退分别取证。正文或模型结果缺许可/版本/来源时隔离，不根据文件存在猜测可信。

完整生产导出和切换属于后续实施；本包未访问生产数据库、未导出任何正文/账号/凭证。
