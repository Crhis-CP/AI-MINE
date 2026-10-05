# ADR-0024：来源用途权限与处理许可的建设期契约

- 状态：已接受（工程决定；TASK-0021精确路径计划已批准，实际强制与消费者随后原子接线）。
- 日期：2026-10-04
- 决策者：架构集成人；依据ADR-0009、ADR-0006第2/5条、内部契约§4/5、DEC-33、TASK-0021。

## 决定

1. `SourcePolicy`是sources所有的不可变权限版本，`permissions`必须完整列出九个来源用途的allow/deny/unknown。用途不是模型能力ID；所有模型能力使用的来源材料都需要external_model许可。九用途之外的syndicate_fulltext不进入该矩阵或ProcessingPermit，不因此开放站外全文。
2. 来源加入时按DEC-33记录九允许、owner_declared依据、真实确认人/时间及范围，附件在范围内；它是显式建档行为，不是schema缺省值。没有证据的allow拒绝保存；收紧理由不被当作allow证据。旧布尔、候选网址和未确认草稿不能被schema转换为许可。reviewed_by保留现行actorOf输出（admin:<userId>或dev:<name>）的非空原字符串，由认证上下文填充，不套用材料ID正则或信任HTTP自称的确认人。
3. scope显式列出主机、路径前缀、文类与排除内容，证据同时声明支持的用途和自身范围。主机是标准URL.hostname的规范形式（含punycode/IPv4/IPv6，不含端口或用户信息），路径是规范URL.pathname的字面前缀，不当成URL或通配式解释；空文类列表表示没有额外文类限制，不代表未知来源可执行。范围匹配、排除项执行和可信资源解析由后续sources实现；网关不得相信HTTP送来的归属/hash。
4. owner_declared的valid_until及其版本expires_at必须为null，不新增自动复核到期。其他明确限期证据可以有期限；其到期不能关闭仍由owner_declared支持的用途。质量资格到期是另一概念，不混进许可。
5. 保留内部契约的ProcessingPermit载荷：__brand、source_id、lane、capability、permission_version、expires_at、issued_at。capability只取九用途；expires_at仍表示许可期限，可为null。
6. 版本1签名封装增加algorithm=Ed25519、issuer_id、非空credential_expires_at、payload、binding和64字节base64url签名。材料绑定包含material_id/revision/content_hash/实际input_fingerprint/资源描述；尚未有材料的获取绑定目标资源和采集配置fingerprint，仅用于fetch，不能作为external_model的材料身份替代。SHA256以64位小写hex表示；字节与字段不做隐式归一或补值。
7. credential_expires_at是签发凭证生命周期，不是Owner许可到期；issuer_id绑定当前进程/DB根的签发实例。后续sources工厂独占私钥；验证端只持公钥与只读当前权限端口。签名覆盖除signature外的整个封装，采用键递归排序、数组顺序保持的UTF-8 JSON。调用者不能在签发请求中自填issuer_id、签发时间或凭证期限；这些由可信工厂决定。网关仅注入SourcePolicyQueryPort只读子面，不得到签发方法。此片不实现密钥、签验、TTL数值、当前版本/时钟/范围或撤销验证。
8. schema只解析未受信任的wire，literal __brand与格式正确的签名不能证明授权。可信ProcessingPermit有额外私有symbol品牌；只有后续sources工厂签发/校验流程授予，不能用schema.parse直接获得。TypeScript品牌仍不是安全边界。
9. 执行前与结果使用/写回前都要核对真实来源、lane、用途、当前权限版本、材料/输入绑定、签名、期限与实例存活。查验失败不返回受限缓存；已发出的请求仍保存响应/用量，未知费用不得抹去或重发。多来源聚合须带完整材料依赖；非来源输入走单独的CapabilityInputAuthorization分支，不能伪造source_id或空来源集合。
10. 许可/业务线/用途审计不成为付费缓存新分区：同一实际输入与配方可以复用原结果，每次使用仍重新核对许可。事件与队列保存材料引用，领取时取得当前permit，不把凭证当长期任务授权。

## 交付与兼容

新增強制前提属于建设期breaking内部契约。首片只交Zod、类型、合成样例和纯回归；不注册HTTP、不改现行private0.2或公开分类/生成物，不激活网关。后续权限存储、组合根生命周期、Ed25519验证器和全部真实消费者按TASK-0021分片建设，再原子启用，不留可选permit或裸模型后门。新模块迁移依赖Task6的显式目录/角色能力，不能先写public表绕过。

SourcePolicyPort.evaluate是typed allow/deny/unknown结果，失败原因区分缺记录、未知、禁止、期限、版本、身份/输入、签名和查验故障；私有HTTP继续使用现有Problem协议，不能回显证据正文、材料、签名或私钥。来源版本持久不可变与当前指针CAS由存储实现保证，schema不替代数据库约束。

## 验证与边界

纯样例覆盖九键缺失/额外键、未知/拒绝不连带关闭其他用途、证据/附件/期限独立、lane/material/revision/hash/获取配置必填、无隐式allow、格式正确的零签名仍只是未受信任数据。没有数据库或真实模型调用；纯契约通过不代表许可已强制或可执行模型。真实并发收紧、缓存/聚合/评测、根撤销与发送前后校验在后续真实签发测试中验证。

推翻条件：若需要新的用途、信任根或跨进程签发，另立契约/ADR并遵守既定授权边界；不能通过增加默认allow或把许可从缓存键读出来取消硬门。


私有HTTP接线采用0.3.0建设期breaking版本：新建必需明确的permission_scope/attachments_in_scope，不从feed托管域推断正文域；创建本身是既有负责人加入确认，不新增审批。现有POST返回created/source或duplicate保持，GET详情增加严格SourcePolicy/null；两个页面和生成客户端同片更新。未登录/CSRF仍先于body验证；未知存储列不隐式进入HTTP，公共契约不变。
