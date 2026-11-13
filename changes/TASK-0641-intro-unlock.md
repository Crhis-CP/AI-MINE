---
type: 优化
audience: 运营
title: 开场动画结束后一定解锁滚动
highlights:
  - 首页第一次打开的开场动画，原来靠页面脚本在结束时解除滚动锁定；现在开场前的引导脚本自己也会在 5.6 秒后解除，页面脚本没加载成功时也不会一直锁住。
reader_unchanged:
  paths:
    - apps/web/app/components/shell/Intro.tsx
    - apps/web/app/components/shell/intro-boot.ts
  reason: 页面脚本正常加载时，开场动画的时长、画面和结束时机与原来一致；引导脚本只是从组件文件挪到单独模块，并多了一个同一时刻的兜底解锁。
---

内部修复记录，不加入公开发布清单。只有页面脚本加载失败或很慢时才看得出区别：原来开场结束后页面可能一直不能滚动，现在 5.6 秒后照常可以滚动。
