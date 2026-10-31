# Folio

给 Agent 用的文档文件夹。指一个目录给它，它把里面的 PDF / docx / pptx / xlsx / html 拆成带页码（或页/节/行）的行，然后暴露一组工具：列清单、看目录、搜索、翻页——外加一套**修改意见单**（提修改、看清单、点了头才写回）。

Agent 不再需要把整份合同读进上下文——它只要问一句话，拿到几行带页码的原文。

## 本轮更新：有预算的读取、可展开的原文、版本校验

七个工具名称不变。`folio_page` 只传 `doc` 时读取整份文档，适合小文件；大文件仍受返回预算限制，不能一次塞满上下文。

```text
folio_page   doc="报销制度.md"
folio_search query="付款" doc="合同A" maxTokens=1200
folio_page   doc="合同A" target="p.12:L3" mode="context" before=2 after=3 version="<搜索返回的版本>"
folio_page   doc="合同A" target="p.12:L3" mode="section" version="<搜索返回的版本>"
```

- `mode=page` 读一个页/幻灯片/工作表/段落；`context` 读附近原文行；`section` 按编号和大纲推断条款边界。无法确定边界时明确返回 `section_boundary_unknown`，并降级成附近几行，不声称已读完整条款。
- `maxTokens` 范围 512–16000，搜索默认 2000，读取默认 3000，包含引用、警告和继续读取的位置。计数使用 **o200k_base 估算**，不等同于 DeepSeek 或其他模型的实际计费 tokenizer。
- 结果含 `next_cursor` 时，读取用相同 `doc` + `cursor` 继续；搜索还需保持 `query/doc/regex` 不变。预算很小时，长行可分段返回；`[char=N]` 为 UTF-16 字符偏移，`[fragment]` 明示这不是完整行。不得把片段当成整条证据。
- 搜索中的 `excerpt` 只用于定位；用返回的 `target` 形式（如 `p.12:L3`）展开后再判断前提、例外和修改内容。

状态区分：`no_match` 是已完成范围内没有匹配；`no_text` 是没有可用文本（扫描件没有执行 OCR）；`parse_failed` 是解析失败；`stale_index` 是旧索引、源文件已变或索引损坏；`source_missing` / `index_unavailable` 是文件不可读；`incomplete` 表示搜索未完成或有文档无法检查。其它文件中的内容不能冒充不可读取文件的证据。明确状态有助于模型判断，但不能保证模型不犯错。

读取和搜索结果附带 `version`。**`folio_revise` 现在必须传入从读取结果拿到的版本**；CLI 对应 `--version`。意见单同时保存源文件 SHA-256，写回前核对整份文件，任何外部改动都会让旧意见单报冲突，即使目标行看似没变。一次只提交部分意见后，其余旧版本意见也需重读再提。无版本的旧意见单不会自动写回。

升级后运行 `folio index --root <目录>`，会重建缺少版本字段的旧索引；索引损坏时用 `--force`。来源校验会读取文件并计算哈希，增加本地 I/O；文件数很大时仍需另测延迟。

本轮测试代码在 `tests/retrieval.test.ts`；真实 Agent 对照题在 `tests/ab/questions-context.json`。先看独立的 [简明结果页](verification.html)，逐次答案与复现口径见 [本轮验证报告](tests/ab/context-report.md)。以下旧数字属于历史实验，不代表本轮改进的收益。

## 先看数字

两种口径都测过了：**理想下限**（整篇读一次 vs 搜一次）和 **真实 agent**（真跑 harness，含试错）。

理想下限，测试语料（30 页合同 + 2 页补充协议 + 1 个 docx），问「付款 期限」：

| | tokens |
| --- | --- |
| 把三份文档整个读进上下文 | 7,032 |
| `folio_search "付款 期限"`（5 条命中） | 220 (3.1%) |
| 搜索 + 翻开其中一页 | 272 (3.9%) |

一句话问 15 次：105,480 vs 4,080。索引 26 KB，建一次，不在模型的时钟上。

真实 agent（pi 1.4.0 + DeepSeek-V4-Flash，8 个问题 × 3 臂 × 每格 3 遍 = 72 次，取中位数）：

| 臂 | 每格中位 prompt | 耗时 | 正确率 |
| --- | --- | --- | --- |
| 原生 `bash`+python（`--no-mcp`） | 49,623 | 188s | 83% |
| folio（`exposure=direct`） | 12,994（**×0.26**） | 40s | 100% |
| folio（`exposure=codemode`） | 21,643（×0.44） | 63s | 75% |

语料再放大到 12 份 / 302 页、问一道要横扫全目录的题，差距进一步拉开：149,116 vs 14,988（**×0.10**），768s vs 186s；而且原生那臂还把「11 处」数成了「2 处」。

真实基线比「整篇读一次」高得多——agent 会重复读、试错、被编码问题绕路（A 臂大半 bash 是导出整页文本）。而且同一题方差很大（A 的表格题单次 164k、中位 23k），**单次数字不要引用**。细节和软肋见 [`tests/ab/FINDINGS.md`](tests/ab/FINDINGS.md)。

自己量：

```
npx tsx src/cli.ts report "付款 期限" --root D:/contracts
```

## 为什么不是「让模型自己读文件」

三件事，分开看：

1. **解析不需要花 token。** 抽文本这一步跑在另一个进程里，模型看不到中间产物。它只收到搜出来的那几行。
2. **索引是无损的。** 存的是 `页码 \t 原文行`，不是摘要、不是 chunk、不是为了 embedding 重写过的句子。查询期回到原文，所以不存在「写入时做了有损承诺、查询时补不回来」。
3. **每一行都带页码。** `合同A:p.12` 是可以核对的引用，不是「大概在某处」。

市面上多数方案在第 2 步就把原文丢了（切块 + 向量化），省 token 的代价是答案不可核对。Folio 相反：文件系统照旧，只在旁边加一份可丢弃的文本镜像。

## 它不做什么

这些是设计选择，不是没做完：

- **不做 OCR。** 扫描件没有文本层，`folio` 会告诉你「这页字太少，可能是扫描件」，然后请你上 OCR。不猜。
- **不做语义搜索。** 没有 embedding。查询是按字面匹配的（空格分隔 = AND，可选 `regex: true`）。它不会「理解」你想问什么——但它也不会把不符的段落硬拐进来。
- **不做表格还原。** 表格在索引里是「用三个空格对齐的一行文字」，能读，但不是结构化数据。
- **不分栏排序。** 双栏排版的 PDF 会按 y 坐标读成「左一句右一句」。
- **不碰 .doc / .ppt / .xls（老的二进制格式）。** 认的是 pdf / docx / pptx / xlsx / html / txt / md / csv / log。老格式自己另存一份。

## 它长什么样

```
folio_list
  3 docs · 41 units · 387 lines · 9.1k chars
  付款条款_内部说明.docx · docx · 9 blk · 264 chars
  合同A_主合同.pdf · pdf · 30p · tables p.2,p.3,p.7 · 8.3k chars
  合同B_补充协议.pdf · pdf · 2p · 486 chars
  ! 付款条款_内部说明.docx: no fixed pages — ¶N is a block index, not a page number

folio_search "万分之"
  4 hits · 3 docs / 387 lines
  [第十二条 付款条款]
  合同A_主合同.pdf:p.12:L10  12.3 甲方逾期付款的，每逾期一日按逾期金额的万分之五向乙方支付违约金，逾期
  合同A_主合同.pdf:p.12:L13  12.4 乙方逾期提交发票或验收单据的，每逾期一日按对应金额的万分之三向甲方支
  [第十四条 违约责任]
  合同A_主合同.pdf:p.15:L5  14.2 乙方逾期交付的，每逾期一日按合同总价款的万分之三支付违约金，累计不超
  [二、具体变更]
  合同B_补充协议.pdf:p.2:L8  2.2 原 12.3 条约定逾期违约金按日万分之五计算，现变更为按日万分之三计

folio_page 合同A 12
  合同A_主合同.pdf:p.12 · unit 12 of 30
  第十二条 付款条款
  12.1 甲方应在收到乙方开具的合规增值税专用发票及相应验收单据后三十（30）日内…
```

`doc` 参数接受部分名（`合同A`），`page` 接受 `12` / `p.12` / `¶12`。

## 目录：先看地图，再翻页

`folio_outline` 给出原文里的标题（`第X章` / `第X条` / `12.1` / `一、`）和它们各在第几页，全部照抄，不做归纳：

```
folio_outline 合同A
  合同A_主合同.pdf · 43 sections · verbatim headings with their unit
    p.3   第一条 定义
    p.4   第二条 服务范围
    p.7   第五条 支付计划
    p.12  第十二条 付款条款
```

30 页的合同，这张地图约 690 token（整篇的 8.8%）。模型不必再猜关键词。搜索命中也会带上自己的章节路径：

```
合同A_主合同.pdf:p.12:L5  12.3 甲方逾期付款的…
```

## 修改：先出意见单，再写入

文档是证据，所以 Folio 不直接改文件。改分三步：

```
folio_revise  doc=合同A target=p.12:L3 version="<读取返回的版本>" text="12.1 …六十日内付款。" reason="对齐补充协议"
  记录 r1，不动文件
folio_revisions
  · r1 合同A.md:p.12:L3  - "…三十（30）日内…" + "…六十日内…"  — 对齐补充协议
folio_apply   doc=合同A        # 需要服务端 --allow-apply 才生效
  ✓ r1 已写入，原文件已备份到 .folio/backup/
```

三条硬规矩：

- **只有 txt / md / csv 和 docx 能被写入**。PDF 没有行模型；pptx / xlsx 是 zip 容器、html 的索引是抽取出来的文本——这三种的行号对不回源文件，写下去就是切错位置，所以只出意见单。docx 也只允许替换文字，不许增删段落。
- **写之前必须备份**（`.folio/backup/<文档>.<时间>.bak`），且只允许写 `--root` 里面的文件。
- **`before` 对不上就拒绝**：别人在你提议之后改过那一行，`folio_apply` 会报冲突，而不是覆盖。

三种动作：`replace`（改这一行）、`insert_after`（在这行后插一段，仅纯文本）、`delete`（删这一行，仅纯文本）。`delete` 的 `before` 就是被删的原文，删之前照样比对。

`folio_apply` 默认关闭（服务端要加 `--allow-apply`）。这样即便模型想动手，也只能停在意见单上。

## 跑起来

```
npm install
npm run build

# 常驻：先把目录索引一遍，然后盯着它变
node dist/cli.js start --root D:/contracts

# 一次性：建好索引就退出，之后只 serve
node dist/cli.js index --root D:/contracts
node dist/cli.js serve
```

接到 MCP 客户端上（以 DSH / Claude 的配置格式为例）：

```json
{
  "mcpServers": {
    "folio": {
      "command": "node",
      "args": ["C:/Users/18246/Desktop/Folio/dist/cli.js", "start", "--root", "D:/contracts"]
    }
  }
}
```

索引默认落在 `<root>/.folio`，`--home` 可以挪走。删掉这个目录等于重置，不会动你的文档。

人也能用：

```
node dist/cli.js search 万分之 --root D:/contracts
node dist/cli.js page 合同A 12 --root D:/contracts
node dist/cli.js report "付款 期限" --root D:/contracts
```

## 自检

```
npm test
```

两段，都跑真代码：

- `tests/parse.test.ts` —— 断言解析的硬性质：12.1 必须落在 p.12、p.7 的表格必须保住列间距、目录不能被目录页带偏、docx 必须警告 `¶N` 不是页码。
- `tests/mcp-smoke.ts` —— 起真进程走 MCP 协议：七个工具、部分名解析、regex、miss 文案、watcher 增删文件、意见单提出→列出→apply 默认关闭、错行号被拒。

## 结构

| 文件 | 干什么 |
| --- | --- |
| `src/cli.ts` | 命令分发；`start` = 索引 → 监听 → serve（stdout 归 MCP，人类消息走 stderr） |
| `src/mcp.ts` | 七个工具的实现与 `INSTRUCTIONS` |
| `src/parse.ts` | PDF（pdfjs 抽文本 + 按基线聚行 + 列间距识别）、docx（mammoth + 块切分）、html（去脚本样式后按块切）、纯文本 |
| `src/parse-office.ts` | pptx（jszip 解 slide XML，一页一片 `sl.N`）、xlsx（共享字符串 + 一表一片 `sh.<表名>`，单元格用三个空格隔开） |
| `src/outline.ts` | 从原文里的标题抽出目录树（含页码），并认领表格目录页、过滤非标题行 |
| `src/indexer.ts` | 遍历目录、按 size+mtime 跳过没变的、清理已删除的 |
| `src/watch.ts` | chokidar 监听，串行处理避免并发写 manifest |
| `src/store.ts` | `manifest.json` + 每篇文档一个 `.txt` 索引；原子写 |
| `src/search.ts` | 字面 AND / regex 搜索、翻页、文档名模糊解析 |
| `src/evidence.ts` | 源文件与索引哈希核对、版本与读取状态 |
| `src/retrieval.ts` | 有预算的读取/搜索、游标分页、上下文和条款展开 |
| `src/revisions.ts` | 修改意见单：提出、列出、写回（含备份、冲突检测、写后重建索引） |
| `src/format.ts` | 给模型看的紧凑纯文本（不是 JSON，JSON 的括号引号要花 token） |
| `src/report.ts` | 用 tiktoken 量「整篇读」vs「搜索」 |

监听器和 MCP server 是同一个进程里的两条独立通道，但按设计可以拆开：`serve` 只读索引，watcher 自己跑。这样多个客户端能共享一份索引，重启 server 也不用重新解析。

## 已知的坑

- **字面匹配会误伤数字**：搜 `12.1` 也会命中 `12.10`。要精确就 `regex: true` 配 `\b12\.1\b`。
- **PDF 永远只读**：`folio_revise` 可以给它提修改意见，`folio_apply` 会明确拒绝。要改就改源文件，再让索引跟上。
- **docx 没有页**：`¶N` 是第 N 个段落块，不是页码。清单里会明确警告，别拿它当引用。
- **中英混排的空格是猜的**：PDF 里没有「空格」这个概念，只有坐标。两个 run 之间空多大算一个空格，是按中位字高估的，个别行会多一个或少一个空格。
- **大目录会慢**：没有增量解析缓存池，每次启动 `start` 会重新 parse 所有 mtime 变过的文件（没变的不碰）。
- **只索引文本层**：`chars < 页数 × 30` 时报警告，但仍然会索引（有总比没有强）。
- **正则限长 200 字**：索引行都很短，超长正则只会是写错了，直接报错而不是让服务卡住。

## 复现那组对比

跑分器、语料、问题集和历史结果都在 `tests/ab/`。pi 本体在 `tests/tmp/pi-run`，模型配置在 `tests/tmp/pi-home/models.json`（provider `aigw`，网关 `http://aigw.dlut.edu.cn/v1`，模型 `DeepSeek-V4-Flash-0731-W8A8`）。

```powershell
node tests/ab/run.mjs --arms A,B,C --model aigw/DeepSeek-V4-Flash-0731-W8A8
node tests/ab/report.mjs
```

每格都会新建独立的工作目录和 pi home，互不干扰；`--qs` 只跑指定题，`--corpus` / `--qfile` 换语料和问题集。

## 为什么叫 Folio

对开纸。也是「一页一页翻」这个动作。
