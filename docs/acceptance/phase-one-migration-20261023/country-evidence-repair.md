# 国家归属的省州证据修复

只读抽查发现两种不同问题，均属于分类执行偏差，不采用国家专用评分解决。

一类是原始结构化回答已经正确提供国家，但校验只认识国家名和既有中国下级法域，删掉British Columbia、Northern Territory、New South Wales及Catamarca等明确地点。Red Chris报道的原始回答覆盖加拿大、澳大利亚和阿根廷，校验后只剩阿根廷；这篇正文确实还包含阿根廷项目产量变化，不能简单移出阿根廷栏目。El Alto审批报道中的Catamarca被删后变成未知。受限原始回执已保存，没有改写来源或模型回答。

另一类是金价报道将阿根廷标为background，本来不属于该条事件的实际作用地，但旧阅读查询把正文/标签提及作为兜底，仍纳入阿根廷栏目。已合并但未发布的统一国别查询去掉该兜底；普通文字检索仍可找到背景提及。

本次在原证据校验中补有限、明确且不歧义的省州别名，只验证模型已给出的国家与角色；不从单个关键词自动推导事件，不开放San Juan等歧义短名，也不扩大矿业范围。新增词表没有改变结构化提示词或模型输入。地域基础可核对[加拿大官方British Columbia说明](https://www.canada.ca/en/canadian-heritage/services/provincial-territorial-symbols-canada/british-columbia.html)、[澳大利亚统计局地区说明](https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-4-july-2026-june-2031/methodology)及[阿根廷官方地区名录](https://www.argentina.gob.ar/jefatura/turismo-y-ambiente/ambiente/articulacion-ambiental/regiones)。

兼容只限这次附加词表前的同一结构提示词、法域字典和原别名表；旧有效证据继续用于列表、计数、详情和API，不让升级清空各国页面。原文修订、分析身份、来源Hash或不相关规则版本不匹配时仍拒绝。旧partial/unknown可在正常处理时重新校验已收到的结构化答案；当前已经完成的结果不循环购买。

红测重现三国证据全部被丢弃。修复后，多国保留、总部排除、错配/歧义拒绝、旧证据兼容与实际已保存回执复用通过；源日期和既有国别查询回归保持。结构化输入/模型/提示词不变时未增加模型请求；若另行修改评分提示词，新评分的费用仍单独记账。生产投影尚未修复，不能把本地回归写成线上结果。

## 已知旧结构版本的证据重验

18国真实覆盖对比后发现另一处失效：b3a8f1ba的structure@4502d2ee48到468c06e1的structure@dc56e3f181只新增scope/fact说明，geography条款及词典未变；包含safety引用的完整版本计算重现旧配方7a017535与现役cb96a6a7。错误来自把整份结构提示词的变化当成全部地理证据无效，不能靠扩大查询兼容集合直接信任旧投影。

本次仅为这一核实过的旧版本开放原文重验，并绑定当前structure@dc56e3f181；未来提示词变更自动关闭例外。readAnalyzedGeography仍查同一材料修订和分析身份、核对sourceHash与容量，然后用当前validateGeography逐项核验原文引文、地名与角色。旧完整/none结论不复用，保留下来的正证据最多为partial，空证明为unknown；公开查询兼容列表没有增加旧配方。原始分析不修改，不运行analyzeArticle或付费回执路径。

在已有阿根廷两个只读快照的相同346个分析/材料绑定中，106篇可复算正证据里102篇属于本次明确旧版本，4篇属于尚未确认的218c7b41，后者继续拒绝。此计数只表明候选修复范围，不是已经修复的生产数量；原始答案中新词表可恢复部分和其他材料缺口仍单列。本补正不解决所有国别覆盖问题，不改变词表待Chris确认和发布前置。

合成红测复现旧有效AR证据被清空；修复后验证当前重验、partial状态、总部排除、错误修订/材料hash/容量/未知版本/伪引文拒绝、旧none不变成当前none、原始分析保留和0新增请求。原文过滤与国家查询回归同时通过。未运行生产重算或更新投影；正式修复批次还需核对当前人工修订、暂停、撤回及影响后列明授权范围。
