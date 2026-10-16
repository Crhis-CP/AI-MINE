# 金属价格扩展

server入口注册原有metals.prices定时任务及/api/site/metal-prices读取接口。站点安装清单决定是否提供扩展；任务名称、半小时频率、停机补跑和原有HTTP缓存规则保留。COLLECT_ENABLED=false时不注册刷新任务。导入定义和读取价格都不触发取价或模型调用。

backend目录拥有来源适配、PDF/工作簿解析、期次与单位校验、存储、刷新和公开读取实现。对外仅提供read、refresh、diagnostics与registry入口；来源适配器和存储细节留在内部。数据仍使用既有publication.metal_prices表，来源ID、期间、单位和币种不变。

核心旧价格入口目前保留兼容转发，价格页和部分运维展示继续调用既有地址；前端页面和运维挂口的归属继续迁移。公开读取沿用只读事务、当前网站官方链接和权限控制，不依靠源码路径变化绕过SQL归属检查。
