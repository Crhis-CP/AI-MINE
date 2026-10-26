# 服务器自行读取文档方案：Docling、PDF.js 与 OCR

2026-10-25；供Chris选择。文中的“本地处理”均指部署在服务器上执行，不要求Owner电脑运行。**可以把一部分文档读取改为本地处理，从而免去这部分外部API调用费；不能据此承诺整个网站“0成本”。** 现有服务器资源、模型及临时文件占用、维护，以及后续DeepSeek理解/评分的费用仍要分别计算。本材料只做官方资料与现有代码核对，未安装、未下载模型、未跑生产文件，也未批准部署。

建议按文件需要分层处理：**普通文字PDF先用项目已有的PDF.js；没有可靠文字层的扫描件再比较OCR工具；多栏、复杂表格或混合页面，再试Docling是否确有改善。** Docling负责把文档读成可追溯的文字和结构，DeepSeek继续负责理解、选材与纠错，不另做一套选材系统。

## 三个主要选择

| 工具 | 优先用途 | 外部调用费与资源边界 | 许可及目前状态 |
|---|---|---|---|
| **现有PDF.js** | 已有文字层的PDF，提取文字、页码及位置。不能把提取不到文字的扫描页当作正常空白页。 | 在本地解析已取得的字节不需外部识别API，也不需加载OCR/版式模型；现成依赖的接入成本最低，但大文件仍需限制页数、字节和耗时。 | Apache-2.0。本仓库已锁定`pdfjs-dist 6.4.299`，用于法规原件读取及Cochilco行情PDF；这不证明资讯PDF入口已接通。[官方API](https://mozilla.github.io/pdf.js/api/draft/api.js.html)、[许可证](https://github.com/mozilla/pdf.js/blob/master/LICENSE)、[本地依赖](../../../packages/backend/package.json)、[已有读取示例](../../../modules/metals/backend/cochilco.ts) |
| **OCRmyPDF + Tesseract** | 扫描PDF/图片文字；OCRmyPDF组织页面处理并生成可搜索文字层，Tesseract承担识别。也可评估只提取所需页的文字，不额外保存整份输出PDF。 | 本地安装引擎和所需语言数据后，可不使用外部OCR API。内存随页面像素及并发增长，临时图像也占磁盘；不是“扫描件越多并发越好”。 | OCRmyPDF为MPL-2.0，Tesseract及官方`tessdata_fast`为Apache-2.0；依赖另核。当前OCRmyPDF安装文档列Python 3.11+、Tesseract及PDF光栅化/字体组件；Ghostscript已不是所有路径都必需，不能套用旧安装清单。[OCRmyPDF许可](https://github.com/ocrmypdf/OCRmyPDF/blob/main/LICENSE)、[安装要求](https://ocrmypdf.readthedocs.io/en/stable/installation.html)、[Tesseract](https://tesseract-ocr.github.io/tessdoc/Installation)、[语言数据许可](https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE) |
| **Docling** | 需要阅读顺序、版面、表格等结构的复杂文档；也支持结合OCR处理扫描页。是否优于前两者要看本站材料。 | 标准本地模型可在CPU运行。预备好依赖和模型后可离线转换；模型加载、页面图像和批处理会占用资源，不能把“支持CPU”理解成4GB共享主站一定够用。 | 代码MIT；模型各有许可证，不能统一当MIT。作为复杂材料候选先做隔离试验，不直接代替所有现有读取器。[项目与许可](https://github.com/docling-project/docling#license)、[模型目录及CPU支持](https://docling-project.github.io/docling/usage/model_catalog/) |

PDF.js现有实现已经对无文字层、图件和容量不足保留缺项，通用读取能力可以从这些实现中提炼复用；这不意味着启动已暂停的法规采集或法规模型。[现有原件读取](../../../modules/policy/backend/domain/extraction.ts)

## Docling能否离线，是否默认调用收费API

- 官方文档说明：模型通常在首次使用时自动下载；离线部署应事先准备**所选**模型，并设置本地`artifacts_path`。应只准备需要的布局、表格和OCR模型，不盲目下载全部可选模型。[离线使用](https://docling-project.github.io/docling/usage/advanced_options/#model-prefetching-and-offline-usage)
- 向远程模型服务发送文档需要显式开启`enable_remote_services`，默认关闭；但这个开关**不禁止首次模型下载**。要验证完全离线，应输入已获准取得的本地文件、使用已准备的本地模型，并在转换试验中禁用外网。下载原件仍由网站现有来源规则负责，不能交给新工具任意抓取。[远程服务边界](https://docling-project.github.io/docling/usage/advanced_options/#using-remote-services)
- 当前官方Python元包要求Python `>=3.10,<4.0`，拉取`docling-slim[standard]`；标准模型相关依赖涉及Torch、Transformers、Docling模型包和OCR组件，具体组合随版本/引擎变化。它不是复制一个小脚本即可使用；实施前应固定发行版、CPU依赖和模型版本，不把开发分支当上线制品。[元包定义](https://github.com/docling-project/docling/blob/main/packages/docling/pyproject.toml)、[依赖与可选组件](https://github.com/docling-project/docling/blob/main/pyproject.toml)
- 许可例子：当前Heron布局模型标Apache-2.0；`docling-models`模型包列CDLA-Permissive-2.0与Apache-2.0双许可。OCR引擎、语言模型、可选视觉模型仍需按实际选取的模型卡和文件留存许可，不能由Docling的MIT覆盖。[Heron模型卡](https://huggingface.co/docling-project/docling-layout-heron)、[Docling模型包](https://huggingface.co/docling-project/docling-models)

## 4核4GB主站的实际约束

本研究按本轮给出的4核4GB条件评估，**没有测量服务器当前空闲内存、磁盘或文档转换峰值**。官方仓库的Apify Actor说明提到最小2GB内存、复杂文档建议4GB及约4GB镜像；这只是该部署方式的参考，不是“4GB主站在同时运行数据库、网站和worker时仍有4GB可给Docling”。本次未找到可套用所有Docling配置与文件的统一最低内存，也未取得本站文档的精确内存/耗时数据。Docling Graph是另一个项目，它的8/16GB配置表不能直接拿来替代本问题。[特定Actor说明](https://github.com/docling-project/docling/blob/main/.actor/README.md)、[Docling FAQ](https://docling-project.github.io/docling/faq/)

可控的试验方式：同时只转换1份文件；CPU模式先以1个推理线程、1页批量作为起点，关闭不需要的图片描述、公式等增强；设置文档页数、文件大小与总处理时间限制。Docling提供`document_timeout`、线程、批量和文件/页数参数，但这些不等于硬内存限制，还应由受限子进程/容器限制CPU、内存、临时空间及最长运行时间。内存上限须在测量主站正常峰值后确定，不能先给新工具分走全部4GB。[选项参考](https://docling-project.github.io/docling/reference/pipeline_options/)、[文件容量限制](https://docling-project.github.io/docling/usage/advanced_options/#impose-limits-on-the-document-size)、[容器资源限制](https://docs.docker.com/engine/containers/resource_constraints/)

OCRmyPDF同样需要约束。官方性能说明的高分辨率页面例子中，单worker峰值可约500MB，四worker约2GB；这不是所有PDF的固定占用，但足以说明不能直接按4核开满。可用`--jobs`、OCR像素上限和Tesseract超时限制工作；超时/跳过页要报告为缺项，不把缺失文字的产物当完整成功。[性能与内存](https://ocrmypdf.readthedocs.io/en/stable/performance.html)、[超时与跳过页](https://ocrmypdf.readthedocs.io/en/stable/advanced.html#time-and-image-size-limits)

## 接入和可验证的小规模比较

1. **保持一个取正文入口。** 现有worker取得有权处理的文件后，按实际格式与文字层情况调用本地读取进程，再把结果交回原有保存和DeepSeek处理。使用同一任务状态、失败记录和人工暂停规则，不另建业务队列或选材体系；不在读者打开网页时启动转换。
2. **先固定少量获准样本。** 覆盖普通文字PDF、扫描件、文字/图像混合页、多栏/跨页表格、较长文档及损坏/受限文件，并覆盖实际中/英/西文。记录原件哈希、页数、字节数和来源许可；样本不能在看到结果后偷偷替换，也不能用它们替代31篇模型效果评测。
3. **在同一限制下比较。** 先记录PDF.js结果；扫描类比较Tesseract/OCRmyPDF，复杂类再加入Docling标准CPU处理。固定文件、工具/模型版本、语言和参数，分别记录冷启动与已加载模型后的耗时、最高实际内存占用（RSS）、CPU时间、模型/临时/输出磁盘占用，以及超时或内存不足。不要把高配官方性能榜当本服务器实测。
4. **同时核对内容。** 逐页检查文字覆盖、顺序、数字、单位、日期、表格行列和缺页；保留原件、页码/位置及失败原因。OCR产生文字不等于识别正确，更不等于已获得完整可信原文。涉及截图、表格或扫描的缺项需如实传递给后续模型，不补造内容或改变入选规则。
5. **按哈希复用。** 缓存键至少绑定文件哈希、读取器/模型版本和参数；复用前再核当前来源许可。相同文件不重复OCR，不让一个来源的许可自动传给另一个来源，也不覆盖人工修订/撤回。允许保存的转换结果与原文版本一一对应。
6. **用结果决定是否接入。** 只有复杂样本的文字/表格质量确有改善、资源上限内运行、失败可停止且主站访问不受影响，才准备具体部署包并申请生产授权。不满足时保持已有轻量工具和诚实等待状态，不在本次研究中全量重处理历史材料或自动扩容。

若只问“还有没有更好项目”，**MinerU可作为后备复杂文档候选，暂不列为这台主站的首选**。当前官方说明支持基础CPU处理，但较高吞吐本地部署建议至少16GB系统内存；其现行许可是Apache-2.0基础上的自定义附加条款，包括对外服务标识和达到规模门槛后的商业许可要求，不能再笼统写成旧AGPL或纯Apache-2.0。具体模型还要逐项核对。[官方资源边界](https://github.com/opendatalab/MinerU/blob/master/docs/en/usage/tiers.md)、[现行许可证](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)

结论仍是：优先把已有轻量读取能力用好，再用受限样本验证Docling/OCR的实际价值。做到本地读取的外部API费为0是可行方向；服务器总成本、后续DeepSeek费用和所有文件的成功率都不能据此承诺为0或100%。当前只是候选建议，不是已批准安装、接入或上线。
