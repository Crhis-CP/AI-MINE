# 给 Owner 看候选读者页面

预览由单独的 Compose 工程运行一个已经在本机载入并核对过的镜像。只把网页接到正式 API。浏览器请求和候选程序的 API 请求都经过只读检查。预览不会连接业务数据卷。正式 Compose 文件是仓库根目录的 `docker-compose.yml`。

在权威 DNS 为 `preview` 添加直连源站的 A 记录。核对正式入口与预览入口分开后，使用本卡的 Caddy 配置；该入口不接 CDN 缓存。预览容器关闭时入口返回 503。首次配置后从未登录的浏览器检查 401、缓存和搜索引擎响应头。

在服务器的 .env 安全录入预览口令的 SHA-256 十六进制摘要 `PREVIEW_PASSWORD_HASH`。口令须由密码管理器或服务器的密码生成器产生，至少 32 字节随机数。Owner 通过安全录入渠道取得口令，用户名为 owner。只有派生摘要传给预览容器，正式 web 和 API 的访问凭据不会传给候选读者进程。不要输出 Compose 渲染结果。

在服务器以 `deploy/preview/preview.sh up <已核对的镜像>` 开启。可在镜像后指定 1 到 24 的整数小时，默认 2。宿主机启动前至少需要 1 GiB 可用内存。用 `deploy/preview/preview.sh status` 查询剩余时间；`deploy/preview/preview.sh down` 立即关闭。容器到期退出，主机或 Docker 重启后保持关闭。预览主机名进入正式 Caddy 配置、证书生效并通过口令和页面核对后，才向 Owner 提供地址。
