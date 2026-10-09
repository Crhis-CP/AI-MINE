# 持久礼貌抓取（TASK-0107）

`withSourceCrawl(source, scope, run)` 建立一次逻辑采集的持久上下文；`crawlFetch(url, options)` 在上下文中复用既有 guardedFetch，逐个真实请求实施 robots 与同hostname节流。不同端口/业务线共用主机租约，robots按origin缓存。没有上下文的 guardedFetch/model transport 保持原行为。已有采集、正文、法规取得与私有预览入口已接上下文，不新增调度器或包出口。

`source.config.crawlProfile` 可设 `sensitive` 和 `minimumIntervalSeconds`（2–86400秒，纳入已有配置审计）；默认2秒、敏感10秒，与robots Crawl-delay取大者。无效Crawl-delay阻止内容访问，不静默当0。生产预约与完成间隔使用数据库实际时钟；`options.now/get`只供隔离测试注入。完成后再留间隔，避免不同worker时钟偏差或响应耗时削弱约束。

robots缓存24小时，404允许；暂不可取得保留明确延后。匹配规则按RFC9309实现分组、最长路径、Allow同长优先、通配与编码；读取仍服从项目较严格的同主机、最多2跳、不降级约束。403、明确验证页、robots禁止与跨主机跳转不走其他路径绕过；不换UA、不登录、不执行来源脚本。429/503的Retry-After写入共享主机冷却。

`CrawlDeferred`带retryAt/reservationId/sessionId；现有news/policy及正文队列用startAfter恢复，等待不占worker，不计为成功/失败或首次新材料。旧续跑任务通过session身份拒绝启动新周期。source首次入库与新闻成功口径未改；预览等待显示明确提示，不显示成0条结果。

`crawlStep(name,url,parse)` 保存已解析步骤，使多请求任务不反复重抓第一页。只在当前store_fulltext许可下缓存正文；纯元数据去掉正文/raw材料字段，日期原始依据保留。缓存写入重新锁定当前许可；成功/终止后删除瞬时响应及步骤，保留会话完成标记。缓存响应携带原始fetchedAt，恢复时不把读取缓存的时间冒作取页时间。

`crawlExternal` 只包装已有来源读取器的源站约束，原付费transport不变；`crawlReadKey`给同一次Jina列表读取稳定回执键。未知/在途结果延后后仍复用同一键，配置调整清掉解析缓存而保留未完成会话身份，不借重试重买。缺许可不以外部读取器绕过保存约束。

这些检查点仅证明调度恢复，不证明目录分页或目录覆盖完整；结构完整回执归TASK-0134。源码不启用held来源，不更改任何模型或质量资格。

## 官方目录整轮扫描（TASK-0134）

法规 `web_list` / `json_list` 通过 `config.directoryProfile` 明确分页请求位置、来源页码、总页数、总记录数、来源记录ID、当前/历史角色和目录范围依据。字段支持 HTML selector/attribute、JSON path、响应 header；page/total 字段可声明 `adjust`（0或1起始差异）和千位分隔。HTML在JSON中时继续使用既有 `htmlJsonPath`。大整数JSON记录ID读取原始数字字面量，不能经浮点舍入。URL记录ID需明确选 `kind:"url"`；不能用自增序号冒作官方ID。`documentId` 缺失时不同文书数为 null，语言记录数不充作文书数。

最小 JSON 配置示例仅说明字段形状，不启用任何来源：

```json
{
  "version": 1,
  "idNamespace": "official-directory-records",
  "scope": { "description": "该官方当前目录及其历史标记", "basis": "该目录字段说明", "evidenceUrl": "https://example.invalid/directory-help", "includesHistory": true },
  "request": { "location": "query", "parameter": "page", "firstPage": 1 },
  "pageNumber": { "field": { "kind": "json", "path": "page" } },
  "totalPages": { "field": { "kind": "json", "path": "pages" } },
  "totalRecords": { "field": { "kind": "json", "path": "total" } },
  "recordId": { "kind": "json", "path": "id" },
  "documentId": { "kind": "json", "path": "document_id" },
  "revisionMarker": { "kind": "json", "path": "revision" },
  "role": { "mode": "field", "field": { "kind": "json", "path": "role" }, "currentValues": ["current"], "historyValues": ["history"] }
}
```

每轮在 `acquisition.directory_scans` 保存契约/许可版本和 next_page，默认每次至多2页。实际请求仍服从0107持久节流；等待用现有 source queue 的 startAfter，不 sleep。成功页、首次发现、记录元数据、绑定与最终回执只追加；worker中断续页。末页后的首页复核使用独立物理请求键并移除条件请求头，不能把缓存首页或304当复核。结构字段不唯一、页序/总数漂移、跨页ID重复、首页变化、容量超限均不应用部分结果，保存失败URL/真实取得时刻/字节hash/错误回执，一分钟后从首页重开；成功与失败页字节只在仍允许 store_fulltext 时保存，否则保留薄证据。契约或许可变更结束旧轮，从新首页开始。

整轮一致才在同一事务写 material metadata、绑定、当前目录头和 `policy.acquire` 唤醒事件。首次发现使用对应页真实 fetchedAt，来源原始日期保持原口径；法规目录不走新闻的首次30条、月份窗口、60条上限和噪声过滤。历史行/历史链接只作证据。目录消失停止当前取得，不推断废止、撤回，也不删除原件与历史。

`directoryMaterialState(source,materialId)` 和 `directoryCoverageEvidence(sourceIds,start,end)` 经既有 `@amp/backend/sources/collect` 转发。当前轮未闭合先让出原件取得；同元数据保留唤醒键和 next_check_at，标记变化或退出后重新列入获得新键，旧事件与重复事件不会重置复查时点。成功检查后的回扫最多7日，明确更短的来源间隔仍保留。公开读取不调用这些写路径。

coverage按真实结构轮回执计 complete/incomplete，报告期末尚未完成的轮计 incomplete；没有适用证据的来源计 missing。成功HTTP不替代完整回执。目录记录数/当前记录数/不同文书数保存在回执；原件取得成功由 policy 工作流及原件回执单独证明，公开数仍由 publication 合格版本计算。源码没有为真实来源虚构分页字段或启用 held 来源，尚未配置结构profile的web/json法规来源会明确报缺配置，RSS成功也不产生完整目录证明。

TASK0144补充真实WordPress目录家族：`pageNumber: {kind:"link_neighbors",header:"link",parameter:"page"}`从响应前后页链接核页码，要求同一集合，拒绝跨主机/改分类、矛盾或缺失关系；不是照抄请求page。`recordScope:{field,anyOf}`逐条核对官方分类，越界使整轮失败，不过滤后假装总数一致。来源声明0记录/0页时保留declaredTotalPages=0，并以一次物理空响应完成校验。读取配方已升为directory-v2，恢复中的旧配方从首页重开。真实配置覆盖与缺口见`docs/research/policy-directory-profiles.md`；当前AR-008仍无全轮complete证明，BLM缺总记录字段不填猜测。
