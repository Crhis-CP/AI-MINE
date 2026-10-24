# 模块页面与后台数据出口

TASK0444是独立兼容契约：既有/api/site/topics、/api/site/topics/:slug与/api/admin/nav-counts补共享schema和文档，不改URL。目录和主题页维持矿业company/field/genre/project以及selected/all口径；页码的原有读取和404行为由后续消费者保留。

主题页可选parts按已安装模块名称隔离，旧响应可以省略。模块只能生成获准公开的投影；消费者先读取模块recheck涉及的当前公开条目，再把current映射交给part构造，不能复用已经撤回的缓存正文。模块自己的数据格式仍由对应模块验证和渲染，本框架不将私有字段自动扩散到公开出口。

后台导航计数是非负整数映射，缺失不能伪装为0；消费者不让扩展覆盖引擎已有计数。既有runs响应可选modules，分别表示ready及data或unavailable；某一扩展失败时其他记录仍可读，异常细节不借此泄露密钥。

本卡只交声明及兼容回归，尚未连接主题/后台消费者，也未运行模块回调、部署或启用新功能。
