---
type: 优化
audience: 运营
title: 统一服务启动与扩展升级
reader_unchanged:
  paths:
    - apps/web/app/routes/about.tsx
    - apps/web/app/routes/all.tsx
    - apps/web/app/routes/home.tsx
    - apps/web/app/routes/topic.tsx
  reason: 仅改为从单一API地址读取，页面内容、接口参数、排序和交互保持。
highlights:
  - 网站和后台共用同一个服务入口，原有登录与访问保护保持。
  - 扩展的数据库升级纳入原发布流程，历史记录与权限检查保持。
---

内部运行调整，不进入读者更新日志。合并不代表已经部署或完成线上验收。
