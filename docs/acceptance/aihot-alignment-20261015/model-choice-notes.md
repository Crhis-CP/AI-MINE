# 模型选择与费用参考

## 2026-10-19：实际配置与现行参考

后台只读核验：当前已配置DeepSeek，近7日真实请求使用`deepseek-flash`；没有自建`model_connections`记录，也没有独立备用通道。Qwen、GLM均未配置，未做连接测试或本站矿业样例比较。本轮资料核验没有开通、购买、切换或调用模型。

DeepSeek官方价格页与10月17日更新日志确认，`deepseek-flash`当前映射到`DeepSeek-V4.1-Flash-1017`，调用名和价格保持不变。历史请求只记录别名，不能据此认定过去7日全部由1017版本服务。[模型映射与人民币价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)；[10月17日更新日志](https://api-docs.deepseek.com/updates/)。

以下均为2026-10-19读取的官方普通API价格，单位为每百万token；人民币与美元分别列示，不作汇率换算。

| 服务与模型 | 币种 | 缓存未命中输入 | 缓存命中输入 | 输出 |
|---|---|---|---|---|
| DeepSeek `deepseek-flash`，空闲时段 | 人民币 | ¥1 | ¥0.02 | ¥4 |
| DeepSeek `deepseek-flash`，高峰时段 | 人民币 | ¥2 | ¥0.04 | ¥8 |
| 百炼北京 `qwen3.8-flash`，单次输入不超过1M | 人民币 | ¥0.8 | 公开文档要求查看控制台，未证实确切价 | ¥2.7 |
| Z.ai海外标准API `glm-5.3-flash` | 美元 | $0.15 | $0.03 | $0.50 |

DeepSeek高峰为北京时间周一至周五9–12、14–18时，不含中国法定节假日，其余为空闲。Qwen上述价格覆盖思考与非思考模式，输出含思维链；`qwen3.8-flash`的显式、隐式缓存均为折扣例外，不能套通用10%或20%。Z.ai的缓存存储仅标为限时免费，上表不是国内BigModel人民币价。[Qwen价格](https://help.aliyun.com/zh/model-studio/model-pricing)；[Qwen缓存计费](https://help.aliyun.com/zh/model-studio/context-cache)；[Z.ai价格](https://docs.z.ai/guides/overview/pricing)。

试用边界：Qwen北京该模型有100万token新人额度，输入输出共用，有效期为开通、模型发布或申请通过三者较晚日起90天；同一实名主体不能重复领取。Owner账号是否仍有资格、余量与有效期尚未核验，已认证账号用完后可自动按量付费，试用前应确认“免费额度用完即停”。DeepSeek和GLM当前账号的通用API赠额未证实；ZCode五天体验不当作本站后台API额度。[百炼新人规则](https://help.aliyun.com/zh/model-studio/new-free-quota)；[ZCode体验与API额度区别](https://zcode.z.ai/cn/docs/configuration)。

当前建议保留已在用的DeepSeek；如Owner需要独立备选，可优先评估Qwen。Qwen与Z.ai均提供OpenAI兼容接口，但接入参数、结构化输出、用量回执及矿业任务质量仍须验证，不能标记为已可接管。供应商、密钥与使用环节由Owner选择。[Qwen接口说明](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)；[Z.ai标准API说明](https://docs.z.ai/guides/overview/quick-start)。

## 2026-10-18：历史建议

以下保留当时研究记录，不代表当前配置或已完成质量比较；当前建议以上方10月19日核验为准。

2026-10-18核对官方页面。以下是供Owner自行选择的建议，未开通服务、填写密钥或改变实际路由；本站矿业样例没有做真实付费比较，不能宣称质量排名。最终录入时须再次查看账户价格与优惠有效期。

建议先保留现有可用模型；需要新增低成本模型时，优先考虑MiMo Flash作预筛、标题导读和翻译候选，MiMo Pro作结构化、归组及报告总述候选。DeepSeek Flash也是可保留的通用候选，较贵Pro只在实际质量有必要时选择。两个独立评分调用仍独立执行，不要求因此购买两个供应商。未通过连接测试或未选择环节的模型不会自动接管任务；新增服务、具体环节和密钥由Owner决定。

| 普通API模型 | 缓存未命中输入/百万token | 输出/百万token | 候选用途 |
|---|---|---|---|
| mimo-v2.6-flash | ¥1 | ¥2 | 高频预筛、标题导读、翻译 |
| mimo-v2.6-pro | ¥3 | ¥6 | 归组、结构化及复杂写作 |
| deepseek-flash | ¥1空闲 / ¥2高峰 | ¥4空闲 / ¥8高峰 | 已有流程继续使用或通用候选 |
| deepseek-v4-pro | ¥4.5空闲 / ¥9高峰 | ¥13.5空闲 / ¥27高峰 | 仅在质量收益明确时选用 |

MiMo数据为中国区普通实时API价；海外分别使用美元计费，不能把人民币单价直接填进美元账本。其Token Plan额度与普通API余额不互通。官方标记v2.5系列于2026-10-21退役，不建议现在新接旧版本；UltraSpeed更贵，后台新闻任务不需仅为速度选它。[MiMo现行价表](https://mimo.mi.com/docs/en-US/price/pay-as-you-go)。

DeepSeek现行deepseek-flash对应V4.1-Flash-1017，Pro对应V4-Pro-0813；旧flash名称会被服务端映射到新版本，历史模型标识不保证模型行为固定。高峰为北京工作日9–12、14–18时（不含法定假日），其余为空闲。[DeepSeek现行价表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

MiMo曾公告新老用户可在余额页领取赠送额度，但该历史公告未写当前每个新账号的固定额度和到期日；不能承诺“注册一定送多少”。应由Owner在余额页查看自己可领取的实际金额、适用模型和有效期。桌面/编程工具免费体验、语音限免和Token Plan不能当普通网站API免费额度。[官方历史赠送说明](https://mimo.mi.com/docs/en-US/news/previous-news/billing)。

估算比较可用同一批输入/输出token及缓存命中率乘价，另算失败重试与双评分；未跑实际矿业样例，不给虚假的每月费用。开发仍为0次真实模型调用。
