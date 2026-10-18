# Agent只读答案

`/api/v1/agent`为匿名只读说明；`/latest`、`/search`、`/hot`、`/stories/:publicId`以及`/daily`、`/weekly`、`/monthly`与指定日期/周/月提供中文Markdown。它与MCP共享公开读模型和答案编排，不在阅读请求中采集、调用模型或写业务数据。原JSON接口和MCP工具保持兼容，程序同步继续使用JSON。

成功返回`text/markdown; charset=utf-8`，条件请求支持ETag/304，错误使用现有Problem JSON及Retry-After。参数、长度和上限以`contracts/http/agent`为准。说明应包含可用能力、诚实空态、资料使用范围和回答提示；外部标题、摘要、综述明确分隔为不可信材料。时间保留来源精度和语义，不能把发现时间称为原文发布时间。资料权限、人工撤回、当前代表稿和报告修订继续由publication统一判断。

本契约准备片未安装处理器；后续在统一升级中实现共享答案、接入HTTP/MCP并验证真实只读角色和不触发付费调用。
