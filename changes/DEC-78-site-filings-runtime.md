---
type: 优化
audience: 运营
title: 备案号改由部署配置填写
highlights:
  - ICP备案号、公安联网备案号和新闻许可证编号不再写在代码仓库里，改由部署者在API运行环境中填写，经站点元数据交给页脚、“更多”页和关于页。
  - 号码格式不对时API拒绝启动，只提示变量名；开启SITE_REQUIRE_FILINGS后缺少ICP或公安备案号也拒绝启动。
reader_unchanged:
  paths:
    - apps/web/app/components/shell/Filings.tsx
    - apps/web/app/components/shell/MobileFooter.tsx
    - apps/web/app/components/shell/Sidebar.tsx
    - apps/web/app/routes/about.tsx
    - apps/web/app/routes/more.tsx
    - apps/web/app/routes/public-layout.tsx
  reason: 生产环境按原号码填写SITE_ICP_FILING与SITE_PUBLIC_SECURITY_FILING后，页脚、“更多”页和关于页显示的号码、链接、位置与样式同原来一致；只是号码的来源从代码常量改为部署配置。未填写的号码与原来一样不显示。
---

这是开源整理的内部记录，不加入公开发布清单。部署前须在生产环境的 .env 中填入两个备案号，并设置 SITE_REQUIRE_FILINGS=true；否则新版本上线后页脚不再显示号码。
