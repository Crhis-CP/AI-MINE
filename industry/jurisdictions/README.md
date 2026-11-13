# 法域与业务线范围

`@amp/industry/jurisdictions` 是纯数据入口，不引入文件系统、后端、数据库或解析依赖。data.json 由 docs/data/jurisdictions-36.json 派生，保留 ID、名称、父级、tier、news_scope/policy_scope、首批标记、地方发布职责及原表省区映射；来源哈希和投影字段见 ../seed/provenance.json。

36 个政策对象由 33 国和 EU/UN/OECD 组成；18 个资讯起点国家、中国 14 个下级法域另有独立导出。巴西是 Owner 2026-11-05 补入的资讯线补充国家（tier `news_addition`），只用于资讯的地理判断、国家筛选与标签，不计入 36。下级法域政策标记为 false，地方来源按发布职责纳入；14 不追加到政策验收的 36 分母中。数量不是范围上限。全部数值是规划字典，实际研究、取得、供稿与运行覆盖仍由新系统事实计算。

TASK-0639 增加阿根廷六个产矿省（AR-J、AR-A、AR-Y、AR-K、AR-M、AR-Z），只开资讯范围。原政策/中国省区统计保留，运行字典下级法域现为中国14个加阿根廷6个；旧地理判断保持有效，不回补。San Juan、Santa Cruz 的省份别名只在已判断国家为 AR 时接受。
