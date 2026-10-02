# AI矿策

AI矿策（AI Mining Policy，`aiminingpolicy.com`）是全球矿业资讯与政策站，副标题“全球矿业资讯”。这个仓库是它的重建代码，按 [`docs/`](docs/README.md) 里的重建交接包（v2.1）分里程碑实施。

## 从哪里读起

| 想做什么 | 先读 |
|---|---|
| 了解产品、已定的决定与里程碑 | [交接包说明](docs/README.md)、[项目总览](docs/00-overview.md)、[决定台账](docs/00-decision-ledger.md) |
| 在仓库里改代码（人或 Agent） | [AGENTS.md](AGENTS.md)，再读 [`tasks/`](tasks/) 里分给你的任务卡 |
| 改和行业有关的内容 | [行业包说明](industry/README.md) |
| 查代码起点与许可 | [UPSTREAM.md](UPSTREAM.md)、[LICENSE](LICENSE)、[NOTICE](NOTICE) |

## 改动怎么合进来

每张任务卡在自己的分支上做，经 PR 合并。提交前跑 `pnpm check`；合并前在干净检出上跑 `make verify TASK=<任务卡号>`，把回执贴进 PR 评论，用法见 [统一验证入口](scripts/verify/README.md)。仓库不依赖 GitHub Actions。
