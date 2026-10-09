# 持久礼貌抓取（TASK-0107）

`withSourceCrawl(source, scope, run)` 建立一次逻辑采集的持久上下文；`crawlFetch(url, options)` 在上下文中复用既有 guardedFetch，逐个真实请求实施 robots 与同hostname节流。不同端口/业务线共用主机租约，robots按origin缓存。没有上下文的 guardedFetch/model transport 保持原行为。已有采集、正文、法规取得与私有预览入口已接上下文，不新增调度器或包出口。

`source.config.crawlProfile` 可设 `sensitive` 和 `minimumIntervalSeconds`（2–86400秒，纳入已有配置审计）；默认2秒、敏感10秒，与robots Crawl-delay取大者。无效Crawl-delay阻止内容访问，不静默当0。生产预约与完成间隔使用数据库实际时钟；`options.now/get`只供隔离测试注入。完成后再留间隔，避免不同worker时钟偏差或响应耗时削弱约束。

robots缓存24小时，404允许；暂不可取得保留明确延后。匹配规则按RFC9309实现分组、最长路径、Allow同长优先、通配与编码；读取仍服从项目较严格的同主机、最多2跳、不降级约束。403、明确验证页、robots禁止与跨主机跳转不走其他路径绕过；不换UA、不登录、不执行来源脚本。429/503的Retry-After写入共享主机冷却。

`CrawlDeferred`带retryAt/reservationId/sessionId；现有news/policy及正文队列用startAfter恢复，等待不占worker，不计为成功/失败或首次新材料。旧续跑任务通过session身份拒绝启动新周期。source首次入库与新闻成功口径未改；预览等待显示明确提示，不显示成0条结果。

`crawlStep(name,url,parse)` 保存已解析步骤，使多请求任务不反复重抓第一页。只在当前store_fulltext许可下缓存正文；纯元数据去掉正文/raw材料字段，日期原始依据保留。缓存写入重新锁定当前许可；成功/终止后删除瞬时响应及步骤，保留会话完成标记。缓存响应携带原始fetchedAt，恢复时不把读取缓存的时间冒作取页时间。

`crawlExternal` 只包装已有来源读取器的源站约束，原付费transport不变；`crawlReadKey`给同一次Jina列表读取稳定回执键。未知/在途结果延后后仍复用同一键，配置调整清掉解析缓存而保留未完成会话身份，不借重试重买。缺许可不以外部读取器绕过保存约束。

这些检查点仅证明调度恢复，不证明目录分页或目录覆盖完整；结构完整回执归TASK-0134。源码不启用held来源，不更改任何模型或质量资格。
