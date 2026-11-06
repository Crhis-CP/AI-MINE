# 交给 Codex：后续发布上线（2026-11-06）

> **写给 Codex。**本文由 Claude 写，Owner 授权交给你执行。这次你**只负责上线**：代码、测试、PR 都已由 Claude 做完，两个 PR（计划 PR #340 与集成 PR，任务卡 TASK-0561）由 Owner 在 GitHub 上批准并合并进 main。你不改代码、不改 `.env`、不开 PR、不加测，只按本文取制品、发布、做上线后检查，写一份报告。
>
> 读法：按 D1、D2…… 的顺序做；命令只跑写出来的，每条只跑一次；尖括号 `<…>` 是要替换的值；本文没写的事一律不做。

## 0. 一句话

取 main 的 CI 制品发布到生产（只加一个索引迁移，`.env` 不变），发布后跑第 3 节的检查，发一份报告，任务结束。

## 1. 铁律

1. 同一条命令以同样原因失败两次就停，写报告，不换办法。
2. 只在网络超时、拉取制品失败时重试一次。
3. 不改代码、配置、测试来过检查；不改写 git 历史；不强推。
4. 生产上唯一的写操作是 D3 的发布脚本。其余全部只读。
5. 上线后不压测、不抓全站、不手动触发采集或重算、不重跑模型；第 3 节某条不符，记下实际值继续下一条，全部做完再报告。例外：P1 健康检查失败立即停止，按第 4 节回滚并报告。

## 2. 已知情况（不要当成新问题）

- **只加索引的迁移**：`database/migrations/acquisition/202611061000_directory_binding_material.sql`，由发布脚本的迁移步骤执行（合成库 61 万行 0.63 秒，期间只短暂挡住目录扫描的写入）。
- **`.env` 不变**：评分版本仍是 `selection-score-shared@a195d5bf17+weights@20542a669a`，各开关不变。
- **更新日志变了，是预期**：
  - 最新一条是这次发布登记的“主屏幕和订阅器里的图标换成新标志”（优化）；
  - 第二条是 2026-11-06 那次，改写后显示为“重大更新 2026.11 · 资讯地图上线，全站焕新”，页面上有资讯地图展示；
  - 以前的条目大多换成了读者口径的新标题，总数从 41 条变为 37 条；
  - 公开接口 `/api/v3/changelog` 里改了标题的条目编号会一次性变化。
- **页面更快是预期**：法规列表、资讯详情、全部动态等服务端读取改为成批读取。第 3 节 P9 只记录前后数字，不下结论。
- **谷歌搜索结果的图标**由谷歌按自己的节奏更新（几天到几周），不是你要处理的事。

## 3. 步骤与检查

### D1 核对 main（5 分钟）

```bash
git fetch origin main
git rev-parse origin/main
```

输出应等于 Claude 在交接消息里给的 `$MAIN`（40 位）。不等就停，问 Claude，不要自己挑一个。

### D2 取 main 的 CI 制品（30 分钟）

与上一份任务书（`docs/research/codex-deploy-brief-20261105.md`）的 S4 完全相同，`$MAIN` 换成 D1 的值：找到 `headSha` 等于 `$MAIN`、`conclusion` 为 `success` 的 “make verify (GitHub Actions)” 运行，从 CI 日志读 `$MANIFEST_SHA256`，下载 `verified-release-$MAIN-attempt-$ATTEMPT`，核对 4 个文件和哈希，记下 `$TREE`、`$SOURCE_SHA256`，原样放到服务器 `$BUNDLE`，在服务器上再核一次哈希。

### D3 发布前快照与发布（90 分钟）

1. 发布前快照（只读）：执行上一份任务书 S5 的全部命令，再记录发布前的页面首字节时间（每个地址 3 次，在服务器上执行）：
   ```bash
   for u in / /all /policies /hot /daily; do for i in 1 2 3; do curl -s -o /dev/null -w "$u %{time_starttransfer}\n" "https://aiminingpolicy.com$u"; done; done
   ```
2. 发布：执行上一份任务书 S7 的命令（`deploy/production-release.sh`，参数用本次的 `$MAIN`、`$BUNDLE`、`$SOURCE_SHA256`、`$MANIFEST_SHA256`、`$TREE`），最后应输出 `exit=0`。这次不需要改 `.env`，发布脚本失败会自己回退，不要再发布第二次，停下报告。

### 上线后检查（在任意能访问公网的机器上，`S=https://aiminingpolicy.com`；P9～P11 在服务器上）

| 编号 | 命令 | 期望 |
|---|---|---|
| P1 | `curl -s -o /dev/null -w "%{http_code}\n" $S/api/health` | `200` |
| P2 | `curl -s $S/api/site/changelog \| python3 -c 'import json,sys;r=json.load(sys.stdin)["releases"];print(r[0]["kind"],r[0]["title"]);print(r[1]["kind"],r[1].get("version"),r[1]["title"]);print(len(r))'` | 第一行 `优化 主屏幕和订阅器里的图标换成新标志`；第二行 `重大更新 2026.11 资讯地图上线，全站焕新`；第三行 `37` |
| P3 | `curl -s $S/changelog \| grep -c '本次主角'` | 不小于 `1` |
| P4 | `for u in /favicon.ico /icon-96.png /icon-144.png /icon-192.png /icon-maskable.png /apple-touch-icon.png /apple-touch-icon-precomposed.png; do curl -s -o /dev/null -w "$u %{http_code} %{content_type}\n" $S$u; done` | 每行 `200` 和 `image/…` |
| P5 | `curl -s $S/manifest.webmanifest \| grep -c maskable` | `1` |
| P6 | `curl -s $S/feed.xml \| grep -c '<image>'` | 不小于 `1` |
| P7 | `curl -s $S/ \| grep -c '"@type":"WebSite"'` | 不小于 `1` |
| P8 | `curl -s -o /dev/null -D - -H 'Sec-Purpose: prefetch' "$S/all.data" \| grep -i '^cache-control'`，再去掉 `-H` 那段执行一次 | 第一次 `private, max-age=5`；第二次 `private, no-store`（只记录实际值；CDN 若不转发 `Sec-Purpose`，第一次也会是 `private, no-store`，照记） |
| P9 | D3 第 1 步的首字节命令再执行一次 | 只记录，与发布前对照 |
| P10 | 上一份任务书 S5 的前两条命令 | 所有服务 `running`，RestartCount 为 0；只记录 |
| P11 | 上一份任务书第 6 节 T16 的日志命令 | 只记录，输出交给 Claude |
| P12 | `curl -s $S/api/site/policies/scope \| python3 -c 'import json,sys;print(json.load(sys.stdin).get("updates"))'` | 与发布前相同 |

## 4. 回滚

- 发布脚本失败：脚本自动回退，不再发布，报告。
- 发布成功但 P1 失败，或 P2～P8 有 3 条以上不符：不要自行回滚，立即报告，等 Owner 决定；Owner 要求回滚时按 `docs/runbooks/release-retention.md` 回到 D3 第 1 步记下的上一个镜像（这次没有 `.env` 改动需要恢复）。

## 5. 报告（只发一次，之后本任务结束）

作为评论发在 Claude 开的集成 PR 上，同时请 Owner 转给 Claude。格式：

```markdown
## 上线报告（<北京时间>）
- 结论：通过 / 有问题 / 停止
- $MAIN / $RUN / $ATTEMPT / $MANIFEST_SHA256：
- 发布开始 / 结束（北京时间）、exit、日志最后 30 行：
- P1～P12：编号 | 期望 | 实际 | 结论
- 发布前 / 后首字节（D3 第 1 步与 P9 的原始输出）：
- P11 日志原文：
- 没做的和异常：
```

不写备案号、`.env` 内容、密钥、服务器 IP；长输出保留开头 20 行和结尾 30 行。

## 6. Owner 自己要做的（你只提醒，不代做）

- 在 Google Search Console 对 `https://aiminingpolicy.com/` 做“网址检查 → 请求编入索引”，让谷歌更快换上新图标。
