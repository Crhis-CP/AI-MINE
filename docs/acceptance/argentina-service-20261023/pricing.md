# 缓存与绝对时段计价接入

TASK-0416后端、TASK-0418后台表单，基于已合并TASK-0413契约。当前状态为本地定向验证，尚未提交、完整验证或部署；产品处理和评分暂停未改，真实模型调用0。

## 行为与依据

- 报价冻结`price_id/price_version/price/quoted_at/rate_window`。在提交前用同一已接受的报价版本选择当前UTC时段；提交后再次检查不改价。没有登记的新时段不自动生成，基础价与旧quote语义保留。
- 单列缓存价使用当前DeepSeek/OpenAI-compatible的prompt_tokens/completion_tokens；须同时取得有效命中、未命中，已知缓存别名不得冲突且命中加未命中等于总输入。input_tokens、output_tokens、cache_read_input_tokens、cache_creation_input_tokens等其他协议混入时保持unknown，不猜总量语义。BigInt定点计算、合计最后向上取整到微元；预留采用输入价和缓存价较高者。完整用量按价计算仍为estimated，供应商实际CNY收费沿actual优先路径。
- 费用缺项写入quote的`settlement_issue`并保持金额null。有效模型结果仍为received，可免费复用，不因费用未知再调用。调用前价格过期另留`pricing_issue`；普通任务继续保留未知金额，声明费用上界的研究任务不能绕过上界。
- 复用已有`settleUsageAttempt`到receipt的覆盖路径，无需修改receipts.ts。真实合成paidRequest已证明回执0.001624元、保护账1624微元、月账estimated0.001624元一致；缺缓存样本三处保留未定价。
- 后台可编辑基础缓存价、每段UTC起止和三项单价；新增、删除、空值及显式0分别保留。缩短有效日期不自动裁剪时段。保存仍使用当前价格版本校验，成功后按已有版本key重新读取表单。

## 定向验证

1. 新增7项克隆库回归：固定用量基础1624/时段812微元；一次取整；缓存缺项/冲突/不守恒；旧quote与实际账单；序列化恢复；免费复用、回执/月账一致；提交前后跨界、过期与研究上界。原21项费用保护回归全部通过，没有修改原断言。
2. 浏览器使用既有生产构建和本地合成私有API，1440及390宽均通过：完整读改存、缩期拒绝且旧时段保留、逐字段修改、0价、删除/清空，无横向溢出。不是手机真机或生产验收。
3. backend/tests定向TypeScript、Web typecheck及生产构建通过。五个改动文件Biome无error/warning，cache.test.ts保留既有21条info。未跑统一check/full，由集成人按最终版本执行。

红绿记录：后端旧代码不具备时段/缓存计算，新用例先失败再通过。初版paidRequest夹具误传bounds，真实参数是costBounds；已修正输入重验，该夹具失败不作业务缺陷证据。UI旧构建不能读取新价格，再构建后验证新字段；其后两次浏览器用例失败分别因控件无障碍名称包含提示文字、保存成功后表单按版本重建折叠。已按实际语义定位并等待真实新表单，没有增加固定睡眠或放松金额/字段断言。

日志在`.verify/argentina-service-20261023/pricing/`：`backend-red.log`、`backend-focused.log`、`backend-final.log`、`ui-red.log`、`ui-green.log`、`ui-build.log`、`ui-types.log`、`test-types.log`、`biome.log`。其中backend-focused含新5项及原21项，backend-final为追加上界分支后的最终6项。

独立审阅两项修复另见`review-red.log`、`review-green.log`及`review-biome.log`。真实事务持advisory锁，观察到等待后把测试时钟由07:59:59推进到08:00:01，旧代码错误保留旧价；现已改成函数时钟并在全部准入等待/检查后冻结，记录08:00:01及2800微元。不同协议输入字段混入的样本由旧估算改为unknown；最终7项新回归和原21项全部通过，backend/tests类型通过。已通过UI无新改动，不重复扩大验收。

## 剩余边界

不从供应商网站自动填价格或推算节假日；未取得缓存未命中分解的接口无法使用缓存优惠估算，只能保持未知或在负责人明确未单列缓存价时沿基础计价。历史账单不按新时段回算。真实供应商账单对照与正式价格登记仍未执行。

共享README、契约、任务索引和发布说明总表由集成人维护；本片未修改它们。此记录和产品更新片段不代表已经上线。
