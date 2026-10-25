---
type: 优化
audience: 运营
title: 主题页模块接线
highlights:
  - 承接现有主题部件接口，按当前页读取并参与页面与摘要。
  - 筛选视图不混入未筛选部件，目录缓存落后时不拿首屏部件替代当前页。
reader_unchanged:
  paths: [apps/web/app/routes/topic.tsx]
  reason: 当前公开安装清单中的metals与policy没有topicPage，默认内容、标题、描述及操作保持不变；原列表和筛选继续由既有pool读取，本次不启用新部件。
---

这是候选版本的内部接线记录，不加入公开发布清单。真实路由回归覆盖可选部件、页码、筛选、目录落后，以及无部件时原摘要和结构化信息保持。后续启用实际读者部件须另说明对应用户变化。
