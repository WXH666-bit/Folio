# tests

## 文档工坊网页

`npm run test:theater` 验证单文件剧场的内联脚本、三组真实回放的事件顺序与来源、短对白、等待/报错/真实写回边界，以及统一时钟的暂停、倍速与取消。浏览器验收覆盖六个独立阶段角色、交接道具、PDF 第 45 页、改稿与审阅抽屉、原链接兼容、手机纵向布局和减少动画模式；模型闭环复用 `tests/tmp/comparison-live` 专用目录及已核验的合成输入，不修改日常工作区或个人 pi。

比赛对照新增 `comparison.test.ts`：覆盖相同输入、双侧副本与独立会话、真实写回状态、非空确认清单、源文档不变、token 计数、原始时间/序号、停止和失败、SSE 续接、刷新不重跑，以及 Linux/macOS/Windows Docker/WSL 命令选择与数据路径映射。`native-sandbox.test.ts` 使用同一份安装的 pi SDK 和已准备的工具镜像，验证真实原生读写、Unicode 路径、只读格式、无密钥/宿主 socket，并复现模型等待期间的 WSL 生命周期。

```sh
npm run test:compare
npm run test:sandbox
```

`record-comparison.ts` 是显式的合成示例采集器：三组均使用相同模型、材料版本、独立会话与副本。只导出归一化事件及必要下载结果，真实模型失败不会被替换成成功回放；环境准备故障修复后，仅重录受影响的一组。原生侧隔离开销和人工等待在界面中分别说明。

`npm run test:web` 测试 Fastify 文件接口、上传同名区分、格式写回限制、草案确认与撤销、空清单拒绝、旧版本冲突、原文引用、下载内容、文件管理，以及 RPC 中文分块/JSONL、工具事件映射、`agent_settled` 结束边界、停止/失败、SSE 序号续接和刷新不重复启动。使用 `tests/tmp/web-tests` 与 `tests/tmp/web-rpc-tests` 专用可写数据；复用项目依赖及根目录 `pi/`，不接触个人 pi。

```powershell
npm run build:web
npm run test:web
npm test
```

真实模型与浏览器验收使用 `FOLIO_WEB_DATA` 指定的 `tests/tmp/web-live` 专用目录，密钥通过已有测试环境传给后端，不写入代码或测试证据。仅重置示例文档与示例会话，依赖安装复用。界面截图、必要事件记录、下载内容核对和执行结果保留在 `tests/tmp/web-*`，不提交临时文件。

## 当前 MCP 与原生 pi 的隔离对照

`ab/native-comparison.mjs` 使用项目 `tests/tmp/pi-run` 中的独立 pi 1.4.0 副本，以及 `tests/tmp/pi-home/models.json` 模型模板。模板通过 `$AIGW_API_KEY` 引用环境变量，不复制个人 pi 配置。跨机器复现需先准备这些本地依赖；它们不会提交到仓库。

六类任务各跑三次，A 组关闭 MCP，B 组接入当前 Folio direct；两组保留相同原生工具及相同路径限制扩展。每次使用全新的配置、用户主目录、临时目录和语料副本；个人 pi 顶层配置文件只做前后指纹比对。配置与工具输入限制不是操作系统沙箱。

```powershell
npm run build
node tests/ab/native-comparison.mjs
node tests/ab/native-audit.mjs
# 根据实际答案填写 ab/native-review.json，runId 必须匹配该轮 manifest.startedAt
node tests/ab/native-report.mjs
```

生成的 `native-comparison.html` 可离线查看，完整统计在 `ab/native-results.json`。原始会话、私有配置和临时文档在 `tests/tmp/`。脚本拒绝覆盖同名测试目录；重新运行时给上述三个脚本传相同的 `--runs tests/tmp/<新目录>`，并重新审阅答案。报告不会复用另一轮的人工评分。

写入核验比较整份目标文件和其余 25 份文档，允许末尾换行与新增 Markdown 段落前空行差异。关键词分数只留作诊断，不作为报告正确性结论。

这里的文件都可以随便删：`tmp/` 已在 `.gitignore` 里，脚本会重建它。

## fixtures（测试件）

`make-fixtures.py` 用 PyMuPDF + python-docx 造三份假文档，字体用 SimHei，保证 PDF 有真的中文文本层：

| 文件 | 内容 |
| --- | --- |
| `fixtures/合同A_主合同.pdf` | 30 页；p.3 术语表（表格）、p.7 支付计划（表格）、**p.12 = 第十二条 付款条款**（12.1 三十日付款、12.3 逾期万分之五） |
| `fixtures/合同B_补充协议.pdf` | 2 页；把 12.1 改成六十日、12.3 改成万分之三 |
| `fixtures/付款条款_内部说明.docx` | 纯文字，没有分页——专门用来验证「¶N 不是页码」这条警告 |

重新生成（需要装好 `pymupdf` 和 `python-docx` 的 Python）：

```
npm run fixtures
```

保存时调了 `subset_fonts()`；不subset的话每个文件约 10 MB，subset 后约 170 KB。

## 快速验证

```
npm run build
npx tsx tests/mcp-smoke.ts
```

它会真的起一个 server（`node dist/cli.js start --root tests/tmp/run`），用 MCP stdio 协议连上去，然后检查：

- 三个工具都在
- `folio_search "万分之"` 返回 p.12 的行、行里带条款号
- `doc: "合同B"` 能收窄到 1 条；`\b12\.1\b` 不会命中 `12.10`
- 搜不到时说 `no hits`，而不是返回空
- `folio_page 合同A 12` 能识别部分文档名，返回条款正文
- 往目录里丢一个文件，不调用任何工具，索引自己变 4 条
- 删掉它，索引自己回到 3 条

## 单独量 token

```
npx tsx src/cli.ts report "付款 期限" --root tests/fixtures --home tests/tmp/.folio
```
