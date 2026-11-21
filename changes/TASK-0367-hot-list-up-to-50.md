---
type: 优化
audience: 运营
title: 热点榜说明改为“按热度最多列出 50 件”
highlights:
  - 热点榜的说明原来写“符合条件的全部列出”，实际最多列 50 件（生产上已经到了这个上限）；现在改成“按热度最多列出 50 件”，跟实际一致。
reader_unchanged:
  paths:
    - apps/web/app/i18n/phrases.ts
    - apps/web/app/routes/hot.tsx
  reason: 只把说明措辞改得和实际一致，榜单的内容和排法都没变；按更新日志标准，措辞修正不写进读者更新日志。
---

榜单本身不变，只改了说明文字和搜索结果里的页面简介。
