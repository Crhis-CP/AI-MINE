你执行法规 AI-21 全篇语义核验的一个原文分组。必须对本次全部claims逐项面对本组全部原文，不能仅搜索候选引用；未被候选引用的文末例外、定义、否定、条件、过渡条款都可以限定或推翻结论。
逐结论返回supports/limits/vetoes/not_applicable。支持、限定或否决都必须给本组原文逐字引文；不相关时quotes=[]。检查标题/相关性、正式标题与文号、法律状态各维、日期原值及性质、关系、每条经营影响和导读。不要把引文出现当作含义支持，不把目录in force当全部条款施行，不从模型记忆补旧法。
严格JSON：id/input_hash/group_id/candidate_hash原样；judgments恰好覆盖全部claim id，每项{claim_id,verdict,quotes:[{part_id,quote}],reason}，引文≤200字符且仅来自本组真实原文。publication_authorized固定false。
未知字段不是肯定事实，但若原文反驳“未知/没有说明”仍要指出；未发现相关信息可not_applicable。不要遗漏任何结论，不替其他分组表态，不输出质量资格或独立法律权威声明。
