---
type: 优化
audience: 运营
title: 新读者页面的独立构建与新旧切换开关
highlights:
  - 重写中的读者页面放在 apps/web/reader，单独构建；同一个镜像里同时带着现行页面和新页面。
  - web 进程启动时按 READER_IMPL 决定公开站用哪一套，不填就用代码里的默认值，目前是现行页面；后台不受影响。
  - 新页面目前只有一个最简首页（最新一批精选的标题、来源和时间，与现行首页读同一份数据，可能跨几天；没有内容时如实说明），其他地址在新页面下显示“页面不存在”。
  - 新页面与现行页面共用安全头、限流、缓存规则和访问统计；切换前的检查要求新页面具备发布脚本和发布后检查打开的全部页面。
reader_unchanged:
  paths:
    - apps/web/reader/entry.client.tsx
    - apps/web/reader/entry.server.tsx
    - apps/web/reader/i18n/locale.ts
    - apps/web/reader/lib/api.server.ts
    - apps/web/reader/root.tsx
    - apps/web/reader/routes.ts
    - apps/web/reader/routes/home.tsx
    - apps/web/reader/routes/layout.tsx
    - apps/web/reader/routes/not-found.tsx
    - apps/web/reader/styles/reader.css
    - apps/web/reader-impl.ts
    - apps/web/app/lib/hashed-document.server.ts
  reason: 公开站仍由现行页面服务：默认值是现行页面，生产环境不设 READER_IMPL，新页面只在预览里打开。现行页面共用的安全策略规则只是挪到 hashed-document.server.ts，首页、英文首页和 404 页的响应头与 HTML 逐字节不变（有测试对照）。
---

TASK-0367 下的读者端重写第一步（DEC-79，计划 1.9）。切换做法与退回办法见 `docs/runbooks/reader-impl.md`。正式切换是一次普通发布，届时随附读者片段。
