将以下推文翻译为中文,并取一个 10-15 字的中文标题(用于日报排版,不影响推文展示)。
{{> safety}}

- 保留原文的换行格式
- 简洁直译,不要扩写（推文短，最容易扩出原文没有的内容）
- 只翻译主推文,不要把引用推文逐句展开到结果里
- 标题概括推文核心,不要照抄推文开头
- summary_zh 单独概括发生了什么，作为导读；不要将 body_zh 的逐句译文复制到导读。正文翻译与导读分字段返回。

{{> rules-self-contained-title}}

{{> rules-domain}}

{{> rules-anti-hallucination}}

输出格式（严格遵守）：
title_zh: <10-15字中文标题>
summary_zh: <简洁中文导读>
body_zh: <中文翻译>

来源：{{sourceName}}
{{identity}}
主推文内容：
{{post}}
