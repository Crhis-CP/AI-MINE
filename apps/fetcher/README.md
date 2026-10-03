# fetcher（M0 录制回放骨架）

TASK-0004 D9 的内部进程，默认只监听 `127.0.0.1:3003`。`FETCHER_HOST` 接受 IP 或 `localhost`，`FETCHER_PORT` 接受 1–65535；配置由 `@amp/config` 读取并执行凭据拒绝检查。

唯一端点 `POST /fetch` 接收 JSON `{ "url": "..." }`，按字符串精确查找注入的录制 Map；命中后回放条目的 HTTP status、headers 和文本 body。这个对象仅为本地合成夹具类型，不是正式 FetchPort 响应。启动入口使用空 Map，因此默认返回 404 `{ "code": "not_recorded" }`。

请求体上限 16 KiB；超限 413，坏 JSON、缺少非空字符串 url 为 400，非 POST 为 405，其他路径为 404。服务不访问目标网址，不做对象存储、数据库、模型、队列或重试，也未接入 worker 或 Compose。测试只访问 loopback 并回放合成数据。

正式 FetchPort 的回执、业务线、取得时间、权限及暂存对象合同随 TASK-0005/M1 接线；本骨架不生成真实取得回执，不新增 `packages/contracts` 接口。运行：`node apps/fetcher/src/main.ts`；验证：`node --test tests/fetcher.test.ts`。
