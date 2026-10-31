# 用真实 harness 验证 Folio

一句话：**在最不利的小语料上（3 份文档），Folio 已经把同一批问题的 token 压到 26%、耗时压到 21%，正确率 100% 对 83%；语料放大到 12 份 / 302 页，压到 10%。**

## 怎么测的

| | |
| --- | --- |
| harness | pi 1.4.0，完全隔离在 `tests/tmp/pi-run`（`PI_CODING_AGENT_DIR` 指向临时目录，没碰机器上真实的 `~/.pi`） |
| 模型 | `deepseek-v4-flash-0731`（`--thinking off`；网关已换成 `aigw` / `DeepSeek-V4-Flash-0731-W8A8`，见 README） |
| 语料 | `tests/ab/corpus`：30 页主合同 + 2 页补充协议 + 1 个 docx |
| 问题 | 8 个：定位 / 跨文件修订 / 表格 / 定义 / 数值 / 陷阱 / 新增条款 / 修改落地 |
| 采样 | 8 题 × 3 臂 × **3 遍 = 72 次**，每次一个全新的工作目录 + 全新 pi home，**每格取中位数** |

三个臂：

- **A 原生**：`--no-mcp`，只能 `read` / `bash` / `write` / `edit`，自己写 python（PyMuPDF）或调 `pdftotext` 解析。
- **B folio direct**：`mcp.json` 里 `exposure=direct`，三个 folio 工具直接出现在工具列表。
- **C folio codemode**：`exposure=codemode`（pi 的默认值），模型写一段 JS 调工具。

隔离这件事必须做：第一轮没隔离时，A 把抽出来的 `a_py.txt`（整份合同文本）留在了共享语料目录里，后面的 B 臂直接 `head -60 main.txt` 就读到了——等于开卷。现在每次运行都 `tests/tmp/ab-work/<arm>-<qid>/` 起一份干净副本。

## 结果（8 题 × 3 遍，每格取中位数）

| 臂 | 每格中位 prompt | 中位 input | 中位 cacheRead | 计费等效* | 平均轮次 | 平均耗时 | 峰值上下文 | 正确率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A 原生 | **49,623** | 42,926 | 8,064 | 43,732 | 13 | 188s | 9.1k | 83% |
| B direct | **12,994** | 10,147 | 4,992 | 10,646 | 5 | 40s | 3.9k | 100% |
| C codemode | **21,643** | 16,151 | 5,504 | 16,701 | 10 | 63s | 4.6k | 75% |

\* 计费等效 = `input + 0.1 × cacheRead`（按多数网关缓存读约 1/10 价估）。逐题明细见 [`report-n3.md`](report-n3.md)。

相对 A：

| 臂 | prompt | 计费等效 | 轮次 | 耗时 | 正确率 |
| --- | --- | --- | --- | --- | --- |
| B direct | **×0.26** | **×0.24** | ×0.38 | ×0.21 | 100% vs 83% |
| C codemode | ×0.44 | ×0.38 | ×0.77 | ×0.34 | 75% vs 83% |

单次（n=1）的旧数据还留在 [`report.md`](report.md)，但**不要引用那一版**：同一道题 A 的表格题一次 164k、一次 23k，单次数字没有意义。

## 钱花在哪了

工具直方图（n=1 那一轮、7 次运行合计，看量级）：

```
A  bash:73  read:7
B  folio_page:19  folio_search:15  folio_list:7
C  codemode:33  folio_page:27  folio_search:20  bash:6  folio_list:4
```

A 的 73 次 `bash` 里大半是「把整页/整份文本导出来 → 看一眼 → 再导下一份」，同一页会被反复读；`pdftotext` 在 Windows 上还吐 GBK 乱码，它花了好几轮才绕到 PyMuPDF。
B 完全没碰 bash：41 次定向调用，每次只拿命中行或需要的那一页。
C 的调用数是 B 的两倍多——codemode 每轮先写一段 JS 再调工具，多一层壳。

## 放大语料：差距会拉开

把语料换成 `tests/tmp/ab-scale`（10 份主合同副本 + 补充协议 + docx，共 12 份 / 302 页），只问一道必须横扫整个目录的题：

> 把这批文件里所有出现「万分之五」的地方都列出来：在哪个文件、第几页。

| 臂 | prompt 合计 | 计费等效 | 轮次 | 工具调用 | 耗时 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A 原生 | 149,116 | 63,868 | 33 | 22（21 次 bash） | 768s | 「共 **2** 处」（把 10 份相同副本合并成 1 处，数错了） |
| B direct | **14,988** | 12,454 | 9 | 5（4 次 folio） | 186s | 「共 **11** 处」，逐份列出 |

**×0.10**。同一类问题，语料从 3 份涨到 12 份，A 的 baseline 从 ×0.20 掉到 ×0.10——因为 A 的开销跟「页数」成正比，B 的开销跟「命中数」成正比。

（公平起见：A 这次发现 10 份副本 MD5 相同，省掉了重复解析，否则差距会更大。）

## 三条结论

1. **省 token 成立，但要看基线。** README 里的 3.1% 是「整篇读一次」的理想下限；真实 agent 不会读一次就完，它会试错、重复读、被编码问题绕路。真实基线是 A 的 **49,623/题**（3 份）和 **149,116**（12 份横扫题），B 分别是 **×0.26** 和 **×0.10**。
2. **正确率没有牺牲，反而更高。** 3 份语料上 100% 对 83%（A 的 q7「补充协议新增条款」3 次只答对 1 次）；12 份语料的横扫题上 B 数对了、A 数错了。
3. **`exposure=direct` 明显优于 `codemode`。** 工具只有 3 个时没有理由用 codemode：token 多 **67%**、轮次翻倍，正确率还掉到 75%（比 A 还差）——多一层「先写 JS 再调工具」在简单检索上只会添乱。

## 这套测法的软肋

- **每格 n=3，够看趋势、不够看分布**：A 的表格题单次最贵 164k、这一轮中位 23k；要对外引用分布得每格 5 遍以上。
- **耗时噪声大**，受网关抖动影响；token 稳定得多，优先看 token。
- **主体是 3 份文档、8 个问题**：放大测试只覆盖了「横扫目录」这一类，没覆盖扫描件、双栏、跨页表格。
- **A 被 Windows 编码问题拖累**（`pdftotext` 输出 GBK、`pdfplumber` 没装）。这是真实摩擦，但确实放大了 A 的开销。
- **判分靠 `expectKeys` 字面命中，仍然粗**：q5 就出现过两条正确答案被判 0%——因为评分只认 `p.6`，答案写的是「第 6 页」。归一化要挪进 `stat.mjs` 的算分路径，而不只是 report 脚本。
- 放大语料用了 10 份内容相同的副本，A 靠 MD5 识别省了重复解析——对 Folio 有利，所以这个 ×0.10 不算夸大。

## 复现

```
# 3 份语料 / 8 题 / 三臂 / 每格 3 遍
. .\tests\tmp\pi-env.ps1                     # 隔离的 pi + 网关 key
$env:FOLIO_PYTHON_DIR = "D:\python3.11"      # A 臂用的 python
node tests/ab/run.mjs --arms A,B,C --repeat 3 --conc 8 --runs tests/ab/runs-n3
node tests/ab/median.mjs --runs tests/ab/runs-n3 --out tests/ab/report-n3.md

# 12 份 / 302 页 / 横扫题 / A vs B
node tests/ab/run.mjs --arms A,B --qs q9-sweep --corpus tests/tmp/ab-scale \
  --qfile tests/ab/questions-scale.json --runs tests/ab/runs-scale --conc 2
node tests/ab/report.mjs --runs tests/ab/runs-scale --qfile tests/ab/questions-scale.json --out tests/ab/report-scale.md
```

单题重跑：`--qs q2-amend`。原始事件流在 `tests/ab/runs-n3/<arm>/<qid>.r<k>.jsonl`。
