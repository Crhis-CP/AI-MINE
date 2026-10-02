# 资产

服务端用到的第三方文件放在这里。随文件的 NOTICE 和 LICENSE 一起保留。

| 目录 | 内容 | 注意 |
|---|---|---|
| `og-fonts/` | Noto Sans CJK SC 2.004 常规与粗体的子集：GB2312 汉字、拉丁字母与标点（SIL OFL 1.1，许可全文见目录里的 LICENSE） | 只用于服务端生成分享图；网页用系统字体，不发字体请求。生成子集的脚本不在仓库里（上游没有提交它）：启用分享图（F-PUB-05）前要重建，把工具、源字体版本与字符集记在这里，并补上缺的字（`docs/04-architecture/04-aihot-adoption.md` 2.13、6.3 与 G26） |

站点自己的图标、Logo、报头字在 `industry/brand/`，由 `scripts/brand-icons.ts` 与 `scripts/nameplates.ts` 用 Noto Sans SC Black 的字形画成（SIL OFL 1.1，见根目录 `NOTICE`）；换站名或行业词后重新生成。
