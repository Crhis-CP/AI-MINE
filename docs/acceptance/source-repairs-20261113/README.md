# TASK-0651：云南人社旧入口修复与Torex停项

本批只对既有news来源hrss-index-html-news修复入口，不新增来源/发布主体，不覆盖已有历史、人工暂停、归档或许可。Torex的迁域不在当前许可内，不列入执行清单。

## 当前护栏与最小改动

查询线4个旧源实际SQL一次于2026-11-13T06:00:49.109816Z取回身份/当前配置摘要；两源许可与安全配置于06:27:01.727251Z同次取得。前两次SSH连接失败未执行SQL，撤回的完成信息不作依据；原52/573查询没有重跑。

HRSS现役kind=web_list、owner为空、启用未归档；当前v2许可覆盖hrss.yn.gov.cn根路径，九用途allow、条件0/无过期/三类限制证据false。存在1条非自动权限变更标记，原样记录，不能据UI审计0宣称没有任何人工决定。这份JSON是政策快照，不是签发的ProcessingPermit；生产执行仍重新检查届时当前版本。

安全投影覆盖全部9个配置键，重算与现役2926939e…摘要一致。目标只改5个键：URL、列表/标题选择器，移除旧整段HTML日期正则并加入明确日期节点。语言、链接选择器/范围、+08日期偏移和YYYY-MM-DD声明完全保留。目录仅补该现役原ID的适配配置，不编造现役tier、频率、参与方式、全文等字段；现有source-intake对existing条目只激活配置/核实身份，保留其它现役运营字段。owner从空值补齐为已确认同一机关hrss.yn.gov.cn，不计新增主体。

官网公示公告父入口/gsgg/静态页通过meta refresh明确指向/gsgg/gztz/，与本目标一致；记录父页单次核对，不宣称全站或其它独立子栏目完整扫描。列表实际取页于04:57:33Z，robots404无规则按现有项目规则准入；复用同日缓存、不重复抓列表。回放前取得与现役相同scope/九用途的本地许可，源仍停用isolated；未使用新建宽许可掩盖生产限制。

## 反馈与文件

- hrss-preview.json：原404状态的明确夹具被现有collector拒绝，复用一次实取的新页经现有preview得到20个有效标题/链接；来源最新日2026-11-11，日期-only无时分。旧404夹具只复现生产观察到的状态，不冒作原始响应字节。
- runtime-guard.json：当前owner/hash、状态、许可范围/版本及最小改动键；所有角色值/秘密均不导出。
- source-intake.json：唯一条目expected_existing:true；现役缺失、暂停/归档、hash或owner已变时不创建/不覆盖。现役owner为空，按官网身份补齐；不更改非空身份。
- torex-stopped.json：当前v2 scope仅torexgold.com，对torex.com的fetch按同scope镜像评估明确deny/resource_mismatch；parseMode也在未覆盖键中。Torex未列intake、不新建替代ID、不扩域、不调用被限定于三条法规来源的旧metadata修复脚本。已交Claude另行迁域/工具安排，未回复不算授权。

模型调用0、生产写入0、CLI apply0。配置回放额外源站GET0，父栏目额外单次GET另记在证据；原始HTML/正文只在仓库外，不进Git。本文不宣称已恢复生产抓取/分析/公开供稿。

## 发布线后续条件

仅在本PR经独立审查、准确最终SHA完整verify、纳入已获授权受测正式版本并上线后，由唯一发布线沿既有审计路径先演练：

```sh
node scripts/source-intake.ts docs/acceptance/source-repairs-20261113/source-intake.json
```

预期1行would_preview_reconcile；任何blocked或preserved_pause保留并回报，不改预期凑通过。docs不在容器时沿既有精确清单只读挂载方式，不运行seed覆盖生产。

正式动作仍只交发布线；本线不执行--apply。生产路径必须用当前许可生成绑定预览，成功才激活同ID配置。随后查询线按真实抓取found/new、正文和公开情况读回，分别记录；没有公开稿不能单凭0判断再次坏源。回滚仓库数据，运行回退需看届时实际状态并经同一审计路径，保留历史与人工记录。
