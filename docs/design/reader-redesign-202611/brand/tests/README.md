# 读者测试包（第 3 阶段）

测试由 Owner 组织，可以用腾讯问卷或当面进行。每人大约 8 分钟。测试的目的是看三条路线在读者眼里各像什么、能不能记住，而不是请读者投票选“最好看的”。

## 材料

- [route-a.png](route-a.png)、[route-b.png](route-b.png)、[route-c.png](route-c.png)：三张标识图，每张只有标识本身，不加文字，不写路线名称。
- 场景样机：放在 [../routes/index.html](../routes/index.html) 和 `style-boards/brand-routes.webp`，只在第 5 步用。

## 人选

- **目标读者**：5–8 位。四类读者（管理层或投资者、法务或合规、分析师、关注海外矿业的读者）每类至少 1 人。
- **文化检查**：再请中文、英文、西班牙语（阿根廷）母语者各 1 位。可以和上面的读者重叠。
- 不记录姓名，每人只记一行，例如“合规 / 铜企 / 5 年”。

## 步骤（三条路线的顺序每人随机打乱）

1. **5 秒印象**：每张图只看 5 秒，然后回答：“你觉得它像什么？想到哪三个词？”
2. **凭记忆画**：三张都看完、等 10 秒后，请读者把记得的那一张画出来，拍照发回。
3. **含义猜测**：“如果这是一个网站的标识，你觉得这个网站是做什么的？”
4. **量表**：每条路线在 6 组词上打 1–7 分，量表与 [../platform.md](../platform.md) 相同：传统—现代、冷静—温暖、厚重—轻盈、严肃—亲切、具象—抽象、张扬—克制。
5. **场景**：看三条路线的场景样机，回答：“哪一个让你更愿意相信这里的矿业消息？为什么？”
6. **负面联想**（文化检查者必答）：“这个形状在你的语言或文化里有没有不好的含义，或者让你想到某个已有的品牌？”

## 问题原文

| 步骤 | 中文 | English | Español |
|---|---|---|---|
| 1 | 你觉得它像什么？想到哪三个词？ | What does it look like to you? Name three words that come to mind. | ¿A qué se parece? Diga tres palabras que le vengan a la mente. |
| 2 | 请把你记得的那一个画出来。 | Please draw the one you remember. | Por favor, dibuje el que recuerde. |
| 3 | 如果这是一个网站的标识，这个网站是做什么的？ | If this were a website's logo, what would the website do? | Si fuera el logotipo de un sitio web, ¿a qué se dedicaría el sitio? |
| 5 | 哪一个让你更愿意相信这里的矿业消息？为什么？ | Which one makes you more willing to trust the mining news here? Why? | ¿Cuál le haría confiar más en las noticias mineras de este sitio? ¿Por qué? |
| 6 | 它在你的文化里有没有不好的含义，或让你想到某个品牌？ | Does it carry a negative meaning in your culture, or remind you of an existing brand? | ¿Tiene algún significado negativo en su cultura o le recuerda a alguna marca existente? |

## 通过标准（同任务书第 7 节）

一条路线需要同时满足以下几点才算通过：
- 至少 5 人在 5 秒后说出与“矿业或资源”或“信息或判断”相关的联想；
- 至少一半人能凭记忆画出它的主要结构；
- 没有人联想到负面含义或某个已有品牌；
- 量表平均值与品牌平台的目标位置相差不超过 1.5。

如果三条都没有通过，就回到第 2 阶段，从入选的 8 稿里换方向，而不是在三条里将就选一个。

## 相似图形检索（Owner，在浏览器里做）

把 route-a.png、route-b.png、route-c.png 分别上传到下列网站，记录检索时最接近的 3 个结果：
- 中国商标网的图形检索；
- WIPO 全球品牌数据库（Global Brand Database）的图像检索；
- TinEye 或 Google Lens。

找到近似标识的路线，按一票否决处理。如果要正式注册商标，是否请商标代理做检索，由 Owner 决定。

## 记录表

```text
编号：T1    角色：分析师 / 某券商 / 3 年    语言：中文
顺序：B A C
A：像__________；三个词：____ ____ ____
B：像__________；三个词：____ ____ ____
C：像__________；三个词：____ ____ ____
凭记忆画的是：A / B / C；能看出主要结构：是 / 否
含义猜测：A ____  B ____  C ____
量表（A/B/C）：传统—现代 _/_/_；冷静—温暖 _/_/_；厚重—轻盈 _/_/_；严肃—亲切 _/_/_；具象—抽象 _/_/_；张扬—克制 _/_/_
更信任：__  因为：__________
负面联想或近似品牌：__________
```

结果整理后放到 `tests/results-<日期>.md`，只放去掉身份信息的记录。
