---
type: 优化
audience: 运营
title: 接通可选反馈草稿副本
highlights:
  - 模块草稿按现有本地草稿优先原则接续，成功保存或确认收件后才清理副本。
reader_unchanged:
  paths: [apps/web/app/routes/feedback.tsx]
  reason: 当前公开清单没有feedbackDraft提供者，默认页面、草稿字段、提交身份、来源及文案保持；仅将原读写集中并接既有可选接口。
---

不加入公开更新清单；实际启用读者功能时另作真实说明。
