# tests

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
