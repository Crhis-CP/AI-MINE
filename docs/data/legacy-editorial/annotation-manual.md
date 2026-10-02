# AI矿策 v2 编辑标注手册（Gold v1 校准版）

状态：`OFFLINE_CALIBRATION`
规则包：`mining-editorial-v2-gold-v1-rc1`
用途：仅用于离线规范、人工标注、确定性回放和候选系统校准。
明确不包含：生产接线、真实 provider、模型调用、Web/API、数据库迁移、部署或云操作。

## 1. 数据与版权边界

Gold v1 只允许两类材料：

1. 项目自有的合成短事实 `SELF_AUTHORED`；
2. 已逐项确认允许保存的短事实 `EXPLICITLY_ALLOWED_SHORT_FACT`。

每个条目只有标题式短事实、时间、来源角色、规范链接和 claim ID。禁止保存第三方全文、正文哈希、网页快照、原始 HTML、模型提示词、模型输出、凭证、IP、证书材料或签名 URL。公开可访问不等于允许保存、送模型、翻译或转载全文；未知权限按对应层失败关闭。

本校准集全部使用 `https://example.invalid/` 和自有合成短事实。fixture 能力不能证明任何真实来源拥有相同权限。

## 2. 标注单位与顺序

最小标注单位是不可变 `item_revision`。同一事件的聚合单位是不可变 `story_revision`。证据单位是 `claim`，热度单位是 `story × time_window`。

固定判定顺序：

1. 核验来源身份和内容权限；权限不足直接停止相应处理。
2. 明确硬负例、仿冒、垃圾或无信息促销时判为 `DROP`。
3. 与既有 Story 有转载、翻译、更新、纠错或反证关系时判为 `CLUSTER_ATTACH`。
4. 只有背景、普通数据点、日历、报告或观点而没有事件变化时判为 `REFERENCE_ROUTE`。
5. 疑似事件但身份、翻译、关联或证据不足时判为 `VERIFY_HOLD`。
6. 其余可识别的新事件或实质状态变化判为 `EVENT_REVIEW`，进入九类专用二审。

不得通过提高分数绕过前面的权限、身份、证据或二审硬门。

## 3. 预筛五分类

### `EVENT_REVIEW`

可识别的新事件，或既有事实的阶段、重要数量、主体、资产、法域、核心证据或结论发生实质变化。进入对应一级分类二审。它不是自动发布决定。

### `REFERENCE_ROUTE`

矿业相关，但只是报告、数据点、背景、解释、日历或观点，不构成新事件。进入资料或知识层，不进入事件流。

### `CLUSTER_ATTACH`

已有 Story 的转载、背景、更新、纠错、翻译或反证。挂入原 Story；若发生实质变化，必须重开二审和选择判断。

### `VERIFY_HOLD`

疑似新事件，但主体、来源真实性、翻译、矿业关联、实体身份或证据不足。进入私有核验队列，不得公开；必须保存闭合 reason code 和复查时间。

### `DROP`

明确越界、非矿业同形词、垃圾、仿冒、无信息促销或禁止处理。记录 reason code 后停止。

## 4. 冻结九类与主分类原则

九类 code 及标准名称是：

1. `policy_regulation`：政策监管；
2. `company_project`：企业与项目（简称“企业项目”）；
3. `commodity_market`：商品与市场（简称“商品市场”）；
4. `capital_ma`：投资并购；
5. `supply_trade_controls`：供应链、贸易与制裁（简称“供应链贸易制裁”）；
6. `esg_community_labor`：ESG、社区与劳工（简称“ESG社区劳工”）；
7. `safety_incident`：人身与生产安全（简称“安全事故”）；
8. `technology_processing`：技术与加工（简称“技术加工”）；
9. `exploration_resource`：勘探与资源（简称“勘探资源”）。

主分类只描述当前新增、可证事实的核心动作，不根据读者兴趣、热度或历史标签选择。允许后续对象另存主题和实体标签，但 GoldCase 的 `primary_category` 必须唯一；无法稳定裁决时记录 `POLICY_GAP`，不得强造金标。

常见分界：

- 出口许可规则以法律义务变化为核心时是政策监管；以跨境准入或制裁对象为核心时是供应链、贸易与制裁。
- 收购权益并同时扩建时，看本条新增核心动作是交易还是项目建设。
- 伤亡事故引发劳工行动时，看本条新增、可证事实是事故本身还是后续劳工/社区事件。
- 技术试验带来资源估算变化时，不能因为同一资产而混淆技术阶段和资源披露。

## 5. 四表分离：Item / Story / E / H

### Item价值（Q）

Item价值以 `item_revision` 为单位，衡量该条目作为代表条目的编辑质量：

- `identity_completeness`：谁、做了什么、对象、地点和时间；
- `status_precision`：阶段、时态和模态是否准确；
- `provenance_traceability`：是否能回到文件、数据、引语或现场记录；
- `quantitative_context`：单位、币种、基线、规模和时间窗；
- `delta_value`：相对 Story 既有材料是否有实质增量；
- `uncertainty_balance`：是否区分事实、归属主张、指控、推断和未知。

Story 再重大，也不能提高写错阶段或来源的 Item价值。转载同稿通常 `delta_value` 很低；正式纠错可以具有很高增量价值。

### Story重要性（I）

Story重要性以 `story_revision` 为单位，衡量事件本身：

- `binding_force`：约束力；
- `scope`：影响范围；
- `magnitude`：影响规模；
- `persistence`：持续性；
- `time_criticality`：时效性；
- `trajectory_change`：是否改变既有轨迹。

条目写得好、转载多或传播快不能提高 Story重要性。重大事故可以 I 高而 Q 低；高质量行业背景可以 Q 高而 I 低。

### E：主张级证据

- `E0`：无可检查支持、仿冒或纯传闻；
- `E1`：可识别但间接、匿名或未核验线索；
- `E2`：一个可追溯直接来源支持该主张，并准确说明谁声称什么；
- `E3`：构成性权威记录足以证明该类事实，或两个真正独立来源实质一致；核心冲突已披露；
- `E4`：多种独立证据模式交叉验证，范围和不确定性明确，无未解决核心冲突。

Story 的 E 取推荐理由中所有决定性 claim 的最低 E，不取平均。事故发生与事故原因、工会提出停产与矿山确实停产、价格变化与价格原因必须拆成不同 claim。

### H：传播热度

H 只衡量去转载来源族后的传播速度、广度、持续性和反作弊互动。必须保存时间窗、来源族数、转载副本数、百分位、信任度和异常 reason code。

一千次同稿转载不能提高 I 或 E。高 H 低 E 只能进入私有核验，不能形成公共热点。低 H 高 I/E 仍可精选。H 在推荐理由中必须标记 `not_evidence=true`。

### 不变量

不得生成综合总分。不得输出 `I + Q + E + H`、overall score 或把任一轴推导成另一轴。选择结果是独立对象：Q/E 先作发布硬门，合格 Story 再按 I 排序，同一 Story 的代表条目才按 Q 选择；H 只参与热点视图。

本规则包不修改、映射或重新解释 v1 的 `score`、55、75、featured、公共契约或 Web 字段。

## 6. 九类二审硬门

完整 required facts、受控动词和 reason codes 以 `review-gates.v1.json` 为唯一机器可读事实源。以下错误均不能被平均分抵消：

- 政策监管：草案当生效，或用新闻稿代替约束性原文；
- 企业与项目：目标/申请当获批，试生产当商业投产；
- 商品与市场：单点价格当异常，评论相关性当原因；
- 投资并购：传闻/MOU/协议/审批/交割混淆，交易价值口径混淆；
- 供应链、贸易与制裁：同名主体误配，调查启动当正式制裁或征税；
- ESG、社区与劳工：指控当事实，只有公司视角，FPIC/咨询/协议混用；
- 人身与生产安全：伤亡未确认，初报原因当最终结论，合并不同事故；
- 技术与加工：实验室结果当商业化，相对改善没有绝对基线；
- 勘探与资源：钻孔当资源/储量，资源量当储量，缺少标准或 QP/CP。

九类主分类 GoldCase 必须经过二审。高风险硬门被触发时只能 `BLOCK` 或 `HOLD`，人工不得无新证据提高 E，也不得覆盖来源权限。

## 7. 推荐理由合同

推荐理由只在选择门通过时生成，并必须满足 `recommendation-reason.schema.json`：

- 说明发生了什么、为什么重要、当前阶段和限制；
- 每个事实性短句绑定 claim；
- 精选的决定性 claim 必须为 E3 或 E4；
- 使用与政策、交易、项目、技术、事故和资源阶段匹配的受控动词；
- 热度单独成段且 `not_evidence=true`；
- 纠错必须引用被替代 claim 并保留修订链；
- 禁止“重磅、颠覆、必然利好/利空、已被证实”等无证据措辞。

没有推荐资格时，`recommendation_reason` 必须为 `null`，选择结果使用闭合 reason code 解释。人工不能在没有新证据时提高 E，也不能用 H 生成理由。

## 8. 转载、独立报道、更新、更正与跨语言

- `REPUBLISH`：同一 origin family；不增加独立证据，只增加 `syndicated_copy_count`。
- `INDEPENDENT_CONFIRMATION`：编辑控制和来源链独立，并对决定性 claim 提供实质新支持。
- `UPDATE`：改变阶段、数量、主体、资产、法域、核心证据或结论时重开二审。
- `CORRECTION`：必须绑定被替代 claim 和较早 revision；旧结果标记为历史，不原地覆盖。
- `TRANSLATION`：跨语言分发不自动成为新 Story 或新独立证据；否定、may/must、时态和数字变化必须人工复核。
- 旧闻只换日期没有增量时使用 `OLD_NEWS_REDATED`，不能制造新 Story。

## 9. GoldCase 标注与分歧处理

每个案例必须进行双人独立标注，两名标注者分别提交：五分类、主分类、Item band、Story band、E 等级和简短依据。不得互看答案后补齐一致。

以下任一差异需要第三名高级编辑裁决：

- 五分类或主分类不同；
- 二审硬门、发布、精选或热点结论不同；
- I/Q 分档不同且跨越选择门；
- E 分歧两级或使推荐资格改变；
- 转载/独立、更新/新事件、纠错/普通更新、跨语言关系不同。

裁决必须覆盖两份原始立场而不是删除它们。若规则本身不足，标记 `POLICY_GAP`，先修规则版本，再新建 Gold 版本；不能为让系统通过而改写答案。

首批明确保存的分歧类型：

1. 出口许可新规：政策监管 vs 供应链、贸易与制裁；
2. 收购权益并宣布扩建：企业与项目 vs 投资并购；
3. 事故后停工抗议：人身与生产安全 vs ESG、社区与劳工；
4. 更正是否只是附件，还是需要重算 Story重要性；
5. 多语言报道是独立确认还是同源翻译。

## 10. 首批覆盖矩阵

首批提交至少 24 例，覆盖全部九类和全部五种预筛处置，并明确包含：

- 草案/通过/刊宪/生效和执法阶段；
- 传闻/MOU/协议/审批/交割；
- 同稿转载、真正独立报道和来源族去重；
- 更新、纠错、反证和旧闻洗新日期；
- 跨语言同 Story、否定、may/must、时态和数字；
- 高热低证据、低热高重要性；
- 实验室/中试/示范/商业化；
- 钻孔/靶区/资源量/储量、不同披露标准和 QP/CP；
- 制裁同名误配、注册号和所有权；
- 事故初报伤亡、最终原因和同矿不同事故；
- 工会、社区、NGO 指控、公司回应和反证；
- benchmark、单位、币种、时间窗、数据延迟和因果分离；
- crypto mining、data mining 等硬负例。

## 11. 扩展到 240 例

240 例仍是校准集，不计正式模型成绩。扩展采用：

- 九类各 20 例，共 180 例；
- 另设 60 个 cross-cut 案例，覆盖转载、更正、跨语言、冲突、营销、传闻、高热低证据和跨类分歧；
- 五种预筛在总体上各至少 24 例；生产分布与边界样本分别报告，不用总平均掩盖；
- 保留现有 case ID 和期望结果，只通过新版本新增；错误修正必须 `supersedes`，不能原地改写；
- 每例继续双审，分歧第三审；按分类、预筛、语言、地区、来源角色和四个独立维度报告一致率。

## 12. 扩展到 2,400 例

正式 Gold v1 目标为 2,400 个候选快照、至少 800 个 Story 簇，每个一级分类至少 120 例：

- 45% 生产分布代表样本；
- 20% 门槛和概念边界；
- 15% 转载、更新、纠错、反证和跨语言；
- 10% 安全、制裁、社区、资源/储量等高风险稀有样本；
- 10% 反事实或对抗配对。

按 Story cluster、origin family、近重复模板和时间整体拆分，禁止同一事件或同稿跨开发/测试泄漏。建议 35% 开发校准、35% 冻结测试、30% 密封审计；10% 重复投放检查标注自洽性。任何来源全文不得被用来“快速扩容”，每例仍须是自有合成或逐项允许保存的短事实。

## 13. 给第二波 13 / 15 / 16 的离线接口

### 给 13：Model Gateway dark mode

13 只读消费 taxonomy、reason codes、review gates、recommendation contract、ruleset manifest 和 GoldCase 的 `input`。候选 `EditorialPrediction` 必须携带精确 `ruleset_id` 与 manifest SHA，并分别输出 prescreen、category、Item、Story、E、H、reason codes、second-review result 和 recommendation；不得输出综合总分，不得写回 Gold truth，不得创建真实 provider、密钥或外部调用。

### 给 15：离线校准与评测

15 消费 Gold final 和候选 prediction，生成 `CalibrationReport`。按分类和五分类报告 confusion；Item、Story、E、H 各自报告一致率、误差和分档，不聚合。必须单列高风险硬门、低 E 误推荐、高热低证据、转载误算独立证据、更正、跨语言、Story merge/split 和理由 claim 覆盖。15 不能反向改 Gold truth，也不能把校准集当生产许可。

### 给 16：离线发布资格门

16 只读消费完成双审/仲裁的 `EditorialDecision`、ruleset/corpus hash 和 recommendation contract。unknown version/hash、缺少两名不同标注者、需要但缺少仲裁、未解决更正/冲突、低证据推荐、事实句未绑定或九类硬门未通过时一律失败关闭。当前接口不连接 v1 publishing、公共 API/Web、数据库、模型、生产或云。

## 14. 回放与变更治理

同一 Gold 输入和同一 ruleset 必须得到 byte-identical canonical 输出。manifest 对 taxonomy、schemas、reason codes、review gates、handbook 和 Gold fixture 使用精确 SHA-256；缺文件、多文件、未知字段、未知 reason code、未知 taxonomy、hash 不符或远程 `$ref` 都失败关闭。

规则状态只允许按独立后续授权演进：`DRAFT → OFFLINE_REPLAY → SHADOW → ACCEPTED → ACTIVE → RETIRED`。本包固定在 `OFFLINE_REPLAY`，`approved_at=null`、`activated_at=null`。本次不创建 shadow、active pointer、生产投影或回滚操作；回滚是停止消费本离线包并继续保持 legacy v1 不变。
