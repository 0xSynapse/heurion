# 论文一测量研究：试做测试稿（30 篇）

生成时间 2026-11-13。脚本在 `scripts/`：`fetch.sh` 下载全文 XML；`gen.py` 生成（调用 `jats.py` 解析、`docx_writer.py` 写 Word）；`check-import.mts` 用 Heurion 导入器复查。选文过程：`search.py`、`search_fill.py`（其他专科），钱医生组见 `qian.json`。只用 Python 标准库，固定随机种子（按 PMC 号），重跑结果一致。

复现：`sh scripts/fetch.sh && python3 scripts/gen.py`，输出在 `out/`（xml/ 与 out/ 不入库）。

## 组成
- Q01–Q12：钱医生团队论文（CC BY）。Q01–Q06 钱医生为第一 / 末位 / 通讯作者，Q07–Q12 为合作作者的临床研究。
- P01–P18：其他 18 个专科的 PLOS One 临床研究（CC BY），每篇附公开审稿记录（reviews.txt）。
- 引用方式：EndNote 17 篇、Zotero 8 篇、纯文本编号 5 篇。

## 每篇的文件
- manuscript.docx：测试稿。带行号；EndNote / Zotero 引用域（结构照抄真实文件）；参考文献表是一个跨段落的域；导师修订（w:ins / w:del，待采纳）；3 条导师批注。
- meta.json：种入的导师修改 H1–H3（数字取舍、措辞、新增句子）和批注 C1–C3 的位置（段落 ID、章节、锚定文字）。
- tasks.json：6 个修改任务及核对条件。T1 改短语、T2 改数字、T3 改表格（无可用表格时改数字）、T4 改写段落、T5 回复批注、T6 新增引用（该引用已从稿件中拿掉）。
- reviews.txt：公开审稿记录（只有 P 组有）。

## 已做的检查
- 30 篇的全部 XML 部件都能正常解析；每篇的域开始与结束标记数量一致；批注锚点与 comments.xml 一一对应。
- LibreOffice 全部能打开并转成 PDF（11–29 页）。
- Heurion 的 importDocx 全部解析成功：批注 30/30；引用原子数 ≥ 引用数；修订块共 144 个；无警告。
- 试做时发现导入器把跨段落的参考文献表域误报为「不完整的域代码」（真实 EndNote / Zotero 文件同样如此），已在导入器与段内补丁里修复。

## 已知局限
- 导师修订、批注、任务里的新数字都是构造内容，不代表原研究结果（meta.json 的 synthetic_note 里有说明）。
- 8 篇没有可用表格（基础研究的表多为图片），T3 改为改数字；其中几篇改的是方法里的实验参数。
- 改数字任务只改一处，可能和同句的分数或互补百分比不一致（如 20.3% (15/74)）。是否要求连带修改，请医生评判时给意见。
- 还没有在 Word / WPS 里实际打开检查。
