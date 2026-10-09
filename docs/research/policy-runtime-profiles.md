# 法规实际取得配置

这些配置只使用既有已批准目录里的来源，不等于启用、持续供稿或内容质量验收；初始化仍保持停用。实际正文保存在本地忽略的`.verify/incident-0114/source-profiles/`，不随配置提交。

## US-009：美国土地管理局正式指令

2026-10-09核对[官方指令目录](https://www.blm.gov/policy/instruction-memorandum)、[PIM 2026-002](https://www.blm.gov/policy/pim-2026-002)及[IM2026-014](https://www.blm.gov/policy/im2026-014)。两个详情由系统TLS校验的正常GET返回200，没有跳转；[robots](https://www.blm.gov/robots.txt)未禁止这两个路径。本机网络取得不代替生产网络验证。

- 只识别正式`Instruction Memorandum`或`Permanent Instruction Memorandum`标识和单文书URI，普通新闻稿、目录页不能据此变成法规。
- 标题、文号、正文都取经验证的单个字段；正文包括政策行动、期限、例外和末尾签署认证信息，排除侧栏导航。
- 上网发布日期取标注的`Post Date/EMS Transmission`可见日期，按月/日/年解释。PIM示例的签发日与上网日不同；HTML时间属性有固定时分，配置保留可见日期精度，不借签发日或模板时分冒充发布时间。
- 正文中显式引用的附件编号必须能在选定附件链接中对应。IM2026-014正文提及附件1，但这次实际HTML未提供下载链接，故保持目录未闭合、不能成为完整解读；其他已取得正文仍可留存。
- 正文完整性、实际模型结果、适用的Owner质量资格和上线持续运行仍须在统一验收中分别确认。

同期自然资源部目录未能经本次网页工具取得，未据此猜测字段或增加生效配置。
