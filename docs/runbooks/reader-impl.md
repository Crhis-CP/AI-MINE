# 读者页面新旧切换（READER_IMPL）

读者端页面正在重写（DEC-79）：旧页面在 `apps/web/app`，新页面在 `apps/web/reader`。两套页面打在同一个镜像里，web 进程启动时按 `READER_IMPL` 决定公开站用哪一套，后台不受影响。

| 取值 | 公开站显示 |
|---|---|
| 不填或空 | 代码里的默认值 `DEFAULT_READER_IMPL`（`apps/web/reader-impl.ts`，目前是 `old`） |
| `old` | 现行页面 |
| `new` | 重写中的新页面；还没重写的地址一律显示“页面不存在” |
| 其他值 | 按默认值运行，启动日志里有一条 `READER_IMPL must be old or new` 的提醒 |

## 什么时候设

- **正式切换（计划 3.10）之前，生产环境不设这个变量。** 新页面只在预览槽里设成 `new` 给 Owner 看。
- 正式切换是一次普通发布：代码里的默认值改成 `new`。此后 `.env` 里写 `READER_IMPL=old` 只用来退回。
- 发布脚本不写这个变量，发布也不会改动 `.env` 里已有的值。

## 怎么设、怎么确认、怎么退回

1. 在服务器的 `.env` 里写一行 `READER_IMPL=new`（或 `old`）。
2. 重建 web 容器：`docker compose up -d --no-deps --force-recreate web`。单纯 `docker restart` 不会重读 `.env`，取值在容器创建时就定了。
3. 确认：web 启动日志里 `"msg":"web started"` 那一行末尾的 `"reader"` 字段是期望的值；用 `new` 时，首页源代码里有 `<meta name="amp-reader" content="new">`。
4. 退回：把 `.env` 里这一行删掉或改回 `old`，再做一次第 2 步。不需要发布，也没有写入任何数据。

切换的那一刻，已经打开的页面在下一次站内点击时可能出错一次，刷新即恢复；CDN 里的旧页面最多再留 30 秒（`PAGE_CACHE_SECONDS`）。
