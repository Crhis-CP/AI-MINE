# 给 Owner 看候选读者页面

预览由单独的 Compose 工程运行一个已经在本机载入并核对过的镜像。只把网页接到正式 API。浏览器请求和候选程序的 API 请求都经过只读检查。预览不会连接业务数据卷。正式 Compose 文件是仓库根目录的 `docker-compose.yml`。

先在 EdgeOne 为预览主机单独接入，禁用该主机所有路径的 CDN 缓存，开通 HTTPS，保持到源站的访问主机名为预览域名。火山引擎只新增一条平台实际分配的 preview CNAME。若证书申请还要求添加其他 DNS 记录，先停下报告。按 Owner 要求，#587 合并且新版本发布后，确认 DNS 与回源证书就绪再启动预览；提前装载会触发重复申请证书。通过 CDN 核对无口令返回 401，认证读取返回禁止缓存和收录头；再用无口令的新会话确认不能取到前一次的页面。预览关闭时返回 503。

在服务器的 .env 安全录入预览口令的 SHA-256 十六进制摘要 `PREVIEW_PASSWORD_HASH`。口令须由密码管理器或服务器的密码生成器产生，至少 32 字节随机数。Owner 通过安全录入渠道取得口令，用户名为 owner。只有派生摘要传给预览容器，正式 web 和 API 的访问凭据不会传给候选读者进程。不要输出 Compose 渲染结果。

在服务器以 `deploy/preview/preview.sh up <已核对的镜像>` 开启。可在镜像后指定 1 到 24 的整数小时，默认 2。宿主机启动前至少需要 1 GiB 可用内存。用 `deploy/preview/preview.sh status` 查询剩余时间；`deploy/preview/preview.sh down` 立即关闭。容器到期退出，主机或 Docker 重启后保持关闭。预览主机名进入正式 Caddy 配置、证书生效并通过口令和页面核对后，才向 Owner 提供地址。

看新读者端时设置服务器专用的 `PREVIEW_READER_IMPL=new`，并在 status 输出中核对 reader=new。默认由候选镜像选择页面。挂载脚本在 Git 中为 100644，应保持对容器内 node 用户可读；容器根文件系统只读，/tmp 使用临时内存盘。
