# 旧项目产品证据索引

整理日2026-09-29。此文件记录本轮实际用于产品蒸馏的文档、类型、代码和测试。只读检查，没有运行旧项目测试、访问生产数据库、调用模型、启用信源或验证线上内容。测试名说明已有回归意图，不表示本轮测试通过。

## 1. 精确版本与读取边界

| 代号 | 根目录/身份 | 本轮用途 |
|---|---|---|
| MAIN-LOCAL | 本机主工作区（路径已略）；本地主工作区main HEAD `1990cf5e375b1ae2255960df7cb33581900a0fd7` | 早期产品设计、源策略、公共Reader、正文/翻译/关系/运营测试的静态蒸馏 |
| MAIN-REMOTE-SNAPSHOT | `65d362407226da856f66477807c5437acf1af27b`；由主Agent本轮只读远端核验提供，git对象本地可读 | 本子任务以`git show`/`git diff --name-only`核对新增ADR0033–0036及产品方案变化，不把本地main当远端最新 |
| POLICY-WORKTREE | 本机法规工作树（路径已略）；HEAD `6d37df802b7b7ff14ed9b34436166c7eb60a9b76` | 2026-09-26批准的法规政策需求、范围、研究、完整附件/模型语义、无运营台目标与状态边界；不是已合并/已上线证明 |

主Agent负责全linked worktree清单和分支/dirty审计；本子任务又只读确认了worktree路径。旧接管包缺失没有被补写成可读。所有旧版本性能、运行数量、当时验收均只是有日期的历史记录。

产品文件使用A/B/C/D：A本轮用户明确目标，B历史用户要求/设计，C静态实现或测试，D本包新建议。讨论索引的U/A/R/H/N是另一来源分类：其A指助手方案，不能与产品A混用。涉及直接讨论原话时本索引指向 [discussion-distillation.md](discussion-distillation.md)，不声称本子任务独立读取了所有聊天原文。

## 2. 文档与测试定位

下列行号对表中版本有效。`根/路径:行`为复查定位，不要求新实现Agent打开旧代码；需求已经写入product目录。

| ID | 版本、文件与行/测试 | 实际支持的产品事实与限制 |
|---|---|---|
| L01 | MAIN-LOCAL `README.md:1–5, 51–103` | 品牌、读者定位、持续流程、旧目标；早期“只参考AIHOT、只元数据、固定技术栈”均不能覆盖本轮重建与后续正文要求 |
| L02 | MAIN-LOCAL `docs/designs/mining-product-overhaul.md:3–23, 25–39, 41–63, 65–91` | 18国新闻历史范围、321原始/320目标、六独立发布方最低烟测、72h真实供给、完整读者功能、全库搜索、真实正文、宽收录、自动公开、存量补齐、下架/人改/未知费用保护、更新日志；该版本旧后台/LME仅外链被后续决定覆盖 |
| L03 | MAIN-LOCAL `docs/source-policy.md:5–19, 21–28, 46–89, 106–115, 133–159` | 候选/运行分开、原始记录不改、唯一性/来源族、真实预览、获取/处理/留存/公开权限分层及适配优先级；早期31 enabled非当前运行数量 |
| L04 | MAIN-LOCAL `docs/architecture/vnext/approved-target-brief.md:112–169, 251–350, 395–529, 851–1656` | 极简来源研究、辅助扩源与人工准入、影响路径/当前潜在/境内外资、法律阶段、精确去重/事件/PolicyThread、人审例外、报告组织；“必须旧架构增量演进”和旧后台范围已被更新目标覆盖 |
| L05 | MAIN-LOCAL `config/v2/editorial/annotation-manual.md:1–17, 19–32, 56–127, 129–166, 168–228`；`taxonomy.v1.json`、`review-gates.v1.json`、`reason-codes.v1.json` | OFFLINE_CALIBRATION；九类、Q/I/E/H分离、证据级别、语义风险、转载/纠错/跨语言、金标与泄漏防护。五分类/二审/旧阈值不是本轮全动态发布硬门，也不是已完成真实评分 |
| L06 | MAIN-LOCAL `docs/designs/frontend/decision.md:1–3, 15–22, 38–60`；`docs/public-web.md:7–50` | 视觉历史已被9/7覆盖；公共私有边界、版本一致、合法空状态/故障区别、时间与本地收藏。无搜索/手机/正文等旧禁止不继承 |
| L07 | MAIN-LOCAL `docs/runbooks/automatic-live-intelligence.md:8–40, 56–112` | 服务器持续工作、来源失败隔离、未知调用不重试、源配置/材料身份/断点、实际来源精度与获取区别。文中当时provider阶段不是本轮固定模型要求 |
| L08 | MAIN-LOCAL `apps/web/lib/reader/types.ts:1–168`；`apps/web/components/reader/pages.tsx:75–346, 388–620`；`apps/web/e2e/reader-mobile.spec.ts:1–127` | Reader字段、body三态、中英段落、公司背景、代表/进展、报告形态和手机旅程静态存在；不证明本轮运行或线上通过 |
| L09 | MAIN-LOCAL `tests/live_pipeline/test_reader.py:55–104, 104–175, 177–215, 276–299`；测试 `test_search_and_facets_cover_beyond_current_page_and_latest_order`、`test_withdrawal_invalidates_search_saved_detail_and_rss`、`test_unknown_current_pointer_never_falls_back_to_cached_content`、`test_report_membership_is_bound_to_coverage_not_the_story_latest` | 全库搜索/分页、撤回全入口、未知指针不缓存回退、北京日期、正文pending/unavailable、代表稿独立、报告时间一致的静态回归意图 |
| L10 | MAIN-LOCAL `services/live_pipeline/event_association.py:138–175`；`tests/live_pipeline/test_event_association.py`测试 `test_same_company_different_project_is_not_even_a_model_candidate`、`test_progress_needs_new_supported_action_and_gets_a_new_event_in_same_story`、`test_unknown_target_unsupported_quote_and_uncertain_output_stay_separate`、`test_identical_authorized_plain_text_avoids_model_and_marks_syndication`、`test_upstream_correction_and_recursive_cycles_invalidate_descendants` | 有界候选、同企业不同项目不误并、真实进展、模糊保持分立、同稿0模型、关系失效；不能据此声称实际跨语言准确率已达标 |
| L11 | MAIN-LOCAL `tests/live_pipeline/test_source_operations.py`测试 `test_rss_bad_sibling_date_only_and_article_country_do_not_inherit_headquarters`、`test_same_feed_content_has_stable_identity_but_corrected_time_changes_revision`、`test_source_requires_matching_real_preview_and_edit_invalidates_prior_admission`、`test_checkpoint_and_page_queue_are_atomic_and_stale_fetch_cannot_advance`、`test_once_only_bootstrap_preserves_owner_changed_source`、`test_unconfirmed_current_snapshot_is_unknown_while_sources_remain_visible` | 坏兄弟隔离、date-only、总部与文章国家、稳定身份、预览绑定、CAS断点、保人改、未知计数 |
| L12 | MAIN-LOCAL `services/live_pipeline/processing.py:52–107, 126–216`；`tests/live_pipeline/test_processing.py:83–158, 258–357` | 结构/证据绑定、事件身份和发布、旧精选硬编码数值、单一权威来源、日报周月及回填/撤回。旧数值仅存在于旧实现，不作为新评分依据 |
| L13 | MAIN-LOCAL `tests/live_pipeline/test_operations.py`测试 `test_manual_publication_is_atomic_and_draft_does_not_overwrite_public_edit`、`test_manual_edit_does_not_restore_withdrawn_and_raw_change_requires_review`、`test_group_withdrawal_cannot_be_bypassed_by_manual_reclassification`、`test_feedback_private_persistent_limited_and_settings_public_only`、`test_safe_retry_preserves_identity_and_unknown_call_blocks_reissue`、`test_conflict_resolution_is_bound_to_saved_revision_and_material`、`test_invalid_screenshot_does_not_accept_svg_or_fake_type` | 人改/抑制/反馈/并发版本/重试的可复用行为测试；不要求复制旧运营台 |
| L14 | MAIN-LOCAL `tests/live_pipeline/test_scrapling_extract.py:76–160`测试 `test_listing_and_article_use_scrapling_not_nav_or_footer`、`test_browser_render_is_opt_in_and_fails_closed_without_fetcher`；`services/live_pipeline/translation.py:28–34` | 清洗范围、动态渲染不存在时不能宣称支持、段落保留；Scrapling是历史实现，非新技术强制选择 |
| L15 | MAIN-LOCAL `services/live_pipeline/translation.py:37–117`；`tests/live_pipeline/test_translation_model.py`测试 `test_long_body_progress_is_private_until_every_segment_is_complete`、`test_chinese_body_reuses_paid_chinese_without_translation_call`、`test_unknown_segment_keeps_reservation_and_does_not_send_again`、`test_free_paid_result_reuse_needs_neither_new_budget_nor_current_prices`、`test_body_tail_and_paragraphs_are_part_of_material_identity`；`test_reader_translation.py:21–94`；`test_translation_store.py:138–287` | 全文/权限/材料身份、完整分段、中文复用、未知费/无新额度复用、公开白名单、暂停/下架保护 |
| L16 | MAIN-LOCAL `tests/live_pipeline/test_country_display.py:23–43, 131–155`；`source_registry.py`的`article_countries`使用点 | Indian land/US$地理歧义、文章当前修订国家投影；不能据字符串规则声称解决完整实体识别 |
| L17 | MAIN-LOCAL `tests/live_pipeline/test_model_config.py:95–188, 215–338` | 密钥不回显、未知价格不启动、能力资格与路由、授权/撤销不清账单、public settings无模型私有状态 |
| L18 | 本包 `evidence/discussion-distillation.md:17–37, 47–65, 68–81`；D01/D02/D03/D04 | 协作者实际读取的用户讨论：不设运营台、评分未定、全部国家、站内价格表、事件总结、读者反馈。D02 chat `6ab538bd-61e4-83e9-a591-d61099a156bd`；D03 chat `6ab0470d-b21c-83ec-8310-f4362051b447`。本子任务复读了蒸馏文件；未独立重读全部原聊天 |
| L19 | MAIN-LOCAL `tests/live_pipeline/test_release_notes.py`、`test_release_notes_routes.py`；`apps/web/lib/reader/types.ts:139–154`；L02:65–73 | 产品更新类型、真实成功后登记、同版本幂等和日期精度；具体测试未运行 |
| L20 | POLICY-WORKTREE `docs/policy-upgrade/requirements.md:3–21, 23–49, 51–61`；`config/policy/scope.json` | 9/26批准13条决定、33国+3组织、不运营台、法规栏目、七主题、完整附件/中文/模型语义、业务隔离、持续验收。scope保存三份原始V2文档历史SHA；本轮没有重新取得原文件验证哈希 |
| L21 | POLICY-WORKTREE `docs/policy-upgrade/source-research.md:1–20, 70–78, 89–107, 109–118`；`config/policy/jurisdictions.json:17–115`；`services/policy_intelligence/coverage.py:48–54` | R01–R07研究、R08运行分离；各主题缺口；历史FR原件TIFF OMITTED/NUL容量反例；当前文件自述partial，不算新系统来源完成 |
| L22 | POLICY-WORKTREE `docs/policy-upgrade/material-processing.md:7–18, 20–42, 46–58` | 文书身份、语言/版本、节点/附件目录、全段理解、缓存定向失效、结构≠语义；旧限额与分段大小是实现值，不继承 |
| L23 | POLICY-WORKTREE `docs/policy-upgrade/acceptance/material-audit.json:1–8, 300–302`；`config/policy/scope.json:末尾note` | 历史期望17/取得16/匹配16/complete=false；F17报送要求原件缺失。不能说本轮已读全部原件、法律真值或排版已认证 |
| L24 | POLICY-WORKTREE `docs/policy-upgrade/interpretation-runtime.md:7–30, 32–45, 47–66` | 全文/翻译分组语义核对、全部原文反证、作用主体和条件、旧法比较需原件、回执恢复、不同日期性质、标题/法律关系；明确真实语义记录仍为空的历史状态，不迁移为已完成 |
| L25 | POLICY-WORKTREE `docs/policy-upgrade/operations-exit.md:1–45` | 退出旧运营台依赖：保来源配置/人改/账单/反馈/服务身份/恢复；不把删页面当消除人工依赖，不用共享新闻暂停控制法规 |
| L26 | MAIN-REMOTE-SNAPSHOT `docs/architecture/decisions/0033-reader-recovery-and-stage-one.md:13–21`、0034 `:18–24, 42–59`、0035 `:8–26`、0036 `:11–30`；POLICY-WORKTREE `apps/web/components/admin-live/content-review.tsx:44–67`、`services/live_pipeline/content_review.py:173–226`及测试`test_language_only_review_does_not_approve_other_dimensions` | 新外文完成稿应有完整可取得中文，中文原文不等可选导读；精选/热点占位与后续取消延期；四选分维度人审、普通具体矿业事项可收、一般获奖/参会/空预告不凭发布方准入；正式评分待初稿；Hermes只是受控试验且结构测试不算真实质量 |

## 3. 静态实现与新要求的差距

- 本地main与远端main存在差异，因此本包没有用本地导航或硬编码精选当最终产品；已额外读取0033–0036及最新POLICY要求。
- `OFFLINE_CALIBRATION`规范与9/8自动宽收录的流程冲突已经消解：保留语义错误反例及独立维度，去掉每篇强制二审/评分准入。
- 新法规范围覆盖旧18国范围；正文需要决定性附件和全篇语义，不受旧新闻1MB容量或仅网页内文限制。
- 旧LME外链限定被较新用户站内价格表需求覆盖；具体许可和报价字段须在新契约中落实，不能没有数据就假装完成。
- 旧后台与Hermes审稿入口属于历史实现；新正常供稿不设运营台，必要审核可另用最小私有工具，仍保留真实维度化意见与保护。
- 老代码验证只检查引文出现、结构、指纹或规则阈值时，不能据此宣称语义准确、精选可靠、真实持续供给或反馈学习有效。

## 4. 覆盖声明

本子任务完成面向产品的主线和关键失败边界蒸馏，不声称逐行阅读所有仓库代码、每个历史会话、所有私有模板或原件。产品文件不复制旧源码或私有正文；范围JSON只提取已批准国家/组织/范围依据与历史输入哈希。原件、真实质量、当前生产数据和所有逐源权利仍需由相应实施/验证阶段取得独立证据。
