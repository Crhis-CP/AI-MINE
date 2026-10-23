# 通用模块扩展声明

TASK0430接续固定上游a0d1e75b00ede7e503ca948e71a468db964b2df2的backend/modules和web/app/modules接口。现有矿业安装项及业务规则不变；声明本身不采集、不付费、不发送、不删除或执行模块回调。

后端声明包含模块HTTP、任务/定时、事务事件、后台计数/运行数据、模型步骤、告警/跟进/保留、主题读取及重新核验、来源类型、Agent/MCP、llms/站点地图与出口notice。现有materialDiscovered、admin.http与队列类型保留。公开内容变化回调接受调用者事务；主题扩展必须通过recheck/current取得仍可公开的资料，不能仅使用缓存成员。

网页声明补充root、Agent、主题、后台运行部件、工具入口、收藏导入、反馈草稿、条款链接和标识清单；页面部件保持懒加载。原navigation/tabs/starred/account及Owner标识保留。导航计数采用共享可扩展键类型，现有三种计数仍兼容；此处仅更新类型，不读取新数据或改变导航展示。

矿业TopicSummary维持company/field/genre/project与selected/all口径；成员使用本项目FeedItemSummary，不导入上游AI行业分类。ModuleBrand沿本地资源/文字回退语义，未附带任何上游品牌素材。

本PR只交声明和兼容类型。emit/requestNotice、实际模块告警/保留、各出口与主题/后台消费者须在独立契约合并后接入并用合成模块验证；没有throw占位或默认实现冒充能力完成。公开HTTP响应如需新增字段另沿契约先行，不通过这份声明绕过许可、人工控制或鉴权。
