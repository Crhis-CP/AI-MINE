# 国家归属的省州证据修复

只读抽查发现两种不同问题，均属于分类执行偏差，不采用国家专用评分解决。

一类是原始结构化回答已经正确提供国家，但校验只认识国家名和既有中国下级法域，删掉British Columbia、Northern Territory、New South Wales及Catamarca等明确地点。Red Chris报道的原始回答覆盖加拿大、澳大利亚和阿根廷，校验后只剩阿根廷；这篇正文确实还包含阿根廷项目产量变化，不能简单移出阿根廷栏目。El Alto审批报道中的Catamarca被删后变成未知。受限原始回执已保存，没有改写来源或模型回答。

另一类是金价报道将阿根廷标为background，本来不属于该条事件的实际作用地，但旧阅读查询把正文/标签提及作为兜底，仍纳入阿根廷栏目。已合并但未发布的统一国别查询去掉该兜底；普通文字检索仍可找到背景提及。

本次在原证据校验中补有限、明确且不歧义的省州别名，只验证模型已给出的国家与角色；不从单个关键词自动推导事件，不开放San Juan等歧义短名，也不扩大矿业范围。新增词表没有改变结构化提示词或模型输入。地域基础可核对[加拿大官方British Columbia说明](https://www.canada.ca/en/canadian-heritage/services/provincial-territorial-symbols-canada/british-columbia.html)、[澳大利亚统计局地区说明](https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-4-july-2026-june-2031/methodology)及[阿根廷官方地区名录](https://www.argentina.gob.ar/jefatura/turismo-y-ambiente/ambiente/articulacion-ambiental/regiones)。

兼容只限这次附加词表前的同一结构提示词、法域字典和原别名表；旧有效证据继续用于列表、计数、详情和API，不让升级清空各国页面。原文修订、分析身份、来源Hash或不相关规则版本不匹配时仍拒绝。旧partial/unknown可在正常处理时重新校验已收到的结构化答案；当前已经完成的结果不循环购买。

红测重现三国证据全部被丢弃。修复后，多国保留、总部排除、错配/歧义拒绝、旧证据兼容与实际已保存回执复用通过；源日期和既有国别查询回归保持。结构化输入/模型/提示词不变时未增加模型请求；若另行修改评分提示词，新评分的费用仍单独记账。生产投影尚未修复，不能把本地回归写成线上结果。
