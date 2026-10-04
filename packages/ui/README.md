# @amp/ui

首批组件直接沿用现有实现：Badge、Kicker、Presence/Collapse、ScoreLabel、Menu/MenuItem，以及管理表格使用的Status.Badge/Dot。按子入口导入，无总barrel；不依赖web、后端、凭据或私有客户端。

公开页面直接消费前五个入口，私有UI从Status入口复用状态徽标。两组Tailwind扫描只列本组当前使用的入口。DOM、类名、焦点/取消和动画时序未改变；颜色仍由现有app.css提供，本包不决定新配色。ThemeSwitch、品牌与主题存储逻辑保留在原位置。

Controls/Page的图标依赖、Tabs/IntentLink的路由与hydration依赖，以及主题函数抽取，按TASK-0007后续自然增量处理。新增组件或扩大依赖须同步实际消费者与边界检查。
