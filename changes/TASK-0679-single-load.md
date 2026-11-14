---
type: 优化
audience: 运营
title: 首次打开只读一次数据，公开页面缓存 30 秒
highlights:
  - 打开页面时先读内容和撤回两个版本号，再读页面数据，版本号随页面下发；浏览器只在版本变了时才重读，首页、详情页、热点榜等页面每次打开不再把数据读两遍。
  - 读者页面的完整页面允许 CDN 和代理共享缓存 30 秒，过期后先用旧的再后台更新；首页不越过下一次定时发布时刻。环境变量 PAGE_CACHE_SECONDS 设为 0 即关闭。
  - 页面数据请求、后台、出错的页面、搜索结果，以及有读取失败、少显示了内容的页面（如页脚备案号没读到）一律不缓存。
  - 读者页面的内联脚本改用哈希白名单，不再使用会被缓存复用的随机数。
reader_unchanged:
  paths:
    - apps/web/app/routes/about.tsx
    - apps/web/app/routes/agent.tsx
    - apps/web/app/routes/all.tsx
    - apps/web/app/routes/country.tsx
    - apps/web/app/routes/daily-archive.tsx
    - apps/web/app/routes/home.tsx
    - apps/web/app/routes/hot.tsx
    - apps/web/app/routes/item.tsx
    - apps/web/app/routes/public-layout.tsx
    - apps/web/app/routes/report-detail.tsx
    - apps/web/app/routes/report-latest.tsx
    - apps/web/app/routes/story.tsx
    - apps/web/app/routes/topic.tsx
    - apps/web/app/routes/topics.tsx
  reason: 这些文件只改了缓存声明、读取失败时的不缓存标记和版本号的读取顺序；页面的内容、版式、文字、提示和撤回规则都没有变。新内容最多晚 30 秒出现，是 Owner 2026-11-14 同意的代价，读者看到的页面与原来一致。
---

TASK-0679 与 TASK-0672 合并交付的内部记录，不加入公开发布清单。规则见 `docs/04-architecture/02-tech-stack.md` 3.3 与决定台账“DEC-78补充·公开页面缓存 30 秒”。生产环境不设 PAGE_CACHE_SECONDS 即按 30 秒；要关闭须在 web 进程的运行环境里设为 0（`docker-compose.yml` 与 `apps/web/runtime-env.ts` 的变量清单尚未加入该变量）。
