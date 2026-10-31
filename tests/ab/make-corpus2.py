#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Build the second, wider corpus: 6 domains x 4 formats + 2 stress files.

Everything is generated, so the ground truth is exact and the whole corpus can
be rebuilt byte-for-byte. Facts that the question set asserts on are also
written to corpus2.truth.json, so a question that drifts shows up as a failure
instead of a silent lie.
"""
import json
import os
import shutil
import sys

import fitz  # PyMuPDF
import openpyxl
from docx import Document
from docx.shared import Pt
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.util import Inches, Pt as PPt

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "corpus2")
FONT = r"C:\Windows\Fonts\simhei.ttf"

A4 = (595, 842)
LEFT, RIGHT, TOP, BOTTOM = 72, 72, 72, 790
BODY_SIZE = 10.5
LINE = 17


def clean():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)


def wrap(text, font_size, width):
    """Crude but predictable: count CJK as 1em, ASCII as half an em."""
    per_line = int(width / font_size) * 2
    out, cur, used = [], [], 0.0
    for ch in text:
        w = 1 if ord(ch) > 0x2E80 else 0.5
        if used + w > per_line:
            out.append("".join(cur))
            cur, used = [ch], w
        else:
            cur.append(ch)
            used += w
    if cur:
        out.append("".join(cur))
    return out


class Pdf:
    def __init__(self):
        self.doc = fitz.open()
        self.page = None
        self.y = 0

    def new_page(self):
        self.page = self.doc.new_page(width=A4[0], height=A4[1])
        self.page.insert_font(fontname="F0", fontfile=FONT)
        self.y = TOP

    def _ensure(self, height):
        if self.page is None or self.y + height > BOTTOM:
            self.new_page()

    def h1(self, text, size=16):
        self._ensure(size * 2.2)
        self.page.insert_text((LEFT, self.y + size), text, fontsize=size,
                              fontname="F0")
        self.y += size * 1.9 + 6

    def h2(self, text, size=12.5):
        self._ensure(size * 2)
        self.page.insert_text((LEFT, self.y + size), text, fontsize=size,
                              fontname="F0")
        self.y += size * 1.7 + 4

    def p(self, text, size=BODY_SIZE):
        for line in wrap(text, size, A4[0] - LEFT - RIGHT - 8):
            self._ensure(LINE + size)
            self.page.insert_text((LEFT, self.y + size), line, fontsize=size,
                                  fontname="F0")
            self.y += LINE

    def gap(self, n=6):
        self.y += n

    def table(self, rows, widths, size=9.5, header=True):
        row_h = 20
        for r, row in enumerate(rows):
            self._ensure(row_h + size)
            x = LEFT
            for c, cell in enumerate(row):
                self.page.insert_text((x + 3, self.y + size + 4), str(cell), fontsize=size,
                                      fontname="F0")
                x += widths[c]
            # light rule under every row
            self.page.draw_line((LEFT, self.y + row_h), (LEFT + sum(widths), self.y + row_h),
                                color=(0.75, 0.75, 0.75), width=0.5)
            self.y += row_h
        self.gap(4)

    def save(self, path):
        self.doc.subset_fonts()
        self.doc.save(path, garbage=4, deflate=True)
        self.doc.close()


def docx_doc(title, blocks, path):
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "SimHei"
    style.font.size = Pt(BODY_SIZE)
    doc.add_paragraph(title).runs[0].bold = True
    for kind, text in blocks:
        if kind == "h1":
            doc.add_heading(text, level=1)
        elif kind == "h2":
            doc.add_heading(text, level=2)
        elif kind == "table":
            rows = text
            table = doc.add_table(rows=0, cols=len(rows[0]))
            table.style = "Table Grid"
            for row in rows:
                cells = table.add_row().cells
                for i, value in enumerate(row):
                    cells[i].text = str(value)
        else:
            doc.add_paragraph(text)
    doc.save(path)


def pptx_deck(slides, path):
    prs = Presentation()
    title_layout = prs.slide_layouts[0]
    bullet_layout = prs.slide_layouts[1]
    cover = prs.slides.add_slide(title_layout)
    cover.shapes.title.text = slides[0][0]
    cover.placeholders[1].text = slides[0][1]
    for title, bullets in slides[1:]:
        s = prs.slides.add_slide(bullet_layout)
        s.shapes.title.text = title
        body = s.placeholders[1].text_frame
        body.text = bullets[0]
        for b in bullets[1:]:
            para = body.add_paragraph()
            para.text = b
            para.level = 0
    prs.save(path)


def xlsx_book(sheets, path):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(name)
        for row in rows:
            ws.append(row)
        for i, _ in enumerate(rows[0], start=1):
            ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = 16
    wb.save(path)


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def scan_pdf(text_lines, path, pages=2):
    """A page that is a picture: no text layer, only pixels."""
    img = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, 34)
    y = 120
    for line in text_lines:
        draw.text((120, y), line, font=font, fill="black")
        y += 60
    tmp = os.path.join(HERE, "_scan.png")
    img.save(tmp)
    doc = fitz.open()
    for _ in range(pages):
        page = doc.new_page(width=A4[0], height=A4[1])
        page.insert_image(fitz.Rect(0, 0, A4[0], A4[1]), filename=tmp)
    doc.save(path, garbage=4, deflate=True)
    doc.close()
    os.remove(tmp)


# --------------------------------------------------------------- 法务 ------

def legal():
    d = Pdf()
    d.new_page()
    d.h1("技术开发合同")
    d.p("合同编号：HT-2025-0417　　甲方：上海启明医疗科技有限公司　　乙方：杭州云栈信息技术有限公司")
    d.p("鉴于甲方拟建设临床数据平台，乙方具备相应技术能力，双方经协商一致，订立本合同。")
    for i, name in enumerate(["定义与解释", "开发内容", "交付与验收", "合同价款", "知识产权", "保密", "违约责任", "争议解决"], start=1):
        d.h2(f"第{'一二三四五六七八九十'[i-1]}条　{name}")
        for j in range(1, 4):
            d.p(f"{i}.{j} 本条约定{name}的具体事项，双方应按第 {i} 条执行，不得单方变更。"
                f"相关流程以附件{chr(64 + j)}为准，附件与本合同具有同等效力。")
        d.gap()
    # Ensure the payment clause lands on a known page: force it onto page 12.
    while d.doc.page_count < 11:
        d.new_page()
        d.p("（本页为条款空白页，用于保持条款编号与页码的对应关系。）")
    d.new_page()
    d.h2("第十二条　付款条款")
    d.p("12.1 甲方应于收到乙方开具的增值税专用发票之日起三十日内支付合同价款。")
    d.p("12.2 合同总价款为人民币肆佰贰拾万元整（￥4,200,000.00），分三期支付。")
    d.p("12.3 逾期付款的，每逾期一日按未付金额的万分之五支付违约金。")
    d.p("12.4 付款以银行转账方式支付至乙方指定账户，账户信息以附件 C 为准。")
    d.p("12.5 乙方应在收到款项后三个工作日内开具相应金额的发票。")
    d.new_page()
    d.h2("第十三条　争议解决")
    d.p("13.1 因本合同引起的争议，双方应友好协商；协商不成的，提交上海仲裁委员会仲裁。")
    d.p("13.2 仲裁裁决为终局裁决，对双方均有约束力。")
    d.save(os.path.join(OUT, "法务_技术开发合同.pdf"))

    s = Pdf()
    s.new_page()
    s.h1("补充协议")
    s.p("协议编号：HT-2025-0417-BC01　　签订日期：2025 年 9 月 3 日")
    s.p("鉴于双方于 2025 年 4 月签订《技术开发合同》，现就部分条款达成如下补充协议。")
    s.h2("一、关于付款期限")
    s.p("原合同 12.1 条“三十日内支付”变更为“六十日内支付”，其余付款条件不变。")
    s.h2("二、关于逾期违约金")
    s.p("原合同 12.3 条“万分之五”变更为“万分之三”，自本协议签订之日起适用。")
    s.h2("三、新增保密条款")
    s.p("15.1 双方对履行本合同过程中知悉的对方技术资料负有保密义务，保密期限为合同终止后五年。")
    s.save(os.path.join(OUT, "法务_补充协议.pdf"))

    docx_doc(
        "修订说明（内部）",
        [
            ("p", "本说明记录 2025 年 9 月对主合同的修订，供法务归档使用。"),
            ("h1", "一、修订清单"),
            ("table", [
                ["条款", "原文", "修订后", "依据"],
                ["12.1", "三十日内支付", "六十日内支付", "补充协议一"],
                ["12.3", "万分之五", "万分之三", "补充协议二"],
                ["15.1", "无", "新增保密义务", "补充协议三"],
            ]),
            ("h1", "二、待办"),
            ("p", "财务部需在 2025 年 9 月 15 日前更新付款台账中的到期日规则，避免按旧条款催款。"),
        ],
        os.path.join(OUT, "法务_修订说明.docx"),
    )

    write(os.path.join(OUT, "法务_条款核查清单.csv"),
          "序号,条款,核查项,结论,负责人\n"
          "1,12.1,付款期限是否已按补充协议更新,是,张岚\n"
          "2,12.2,合同总价与发票金额是否一致,是,张岚\n"
          "3,12.3,违约金比例是否同步,待确认,王恺\n"
          "4,13.1,争议解决机构是否明确,是,王恺\n"
          "5,15.1,保密期限是否写入,是,李萌\n")

    return [
        {"file": "法务_技术开发合同.pdf", "domain": "法务", "format": "pdf",
         "facts": {"付款期限": "三十日", "违约金": "万分之五", "合同总价": "4,200,000", "仲裁机构": "上海仲裁委员会"}},
        {"file": "法务_补充协议.pdf", "domain": "法务", "format": "pdf",
         "facts": {"付款期限": "六十日", "违约金": "万分之三", "新增条款": "15.1 保密义务"}},
        {"file": "法务_修订说明.docx", "domain": "法务", "format": "docx",
         "facts": {"修订条数": "3 处", "台账更新截止": "2025 年 9 月 15 日"}},
        {"file": "法务_条款核查清单.csv", "domain": "法务", "format": "csv",
         "facts": {"待确认项": "12.3", "行数": "5"}},
    ]


# --------------------------------------------------------------- 财税 ------

def finance():
    rows = [["日期", "摘要", "科目", "金额（元）", "经办人"]]
    data = [
        ("2025-01-12", "服务器托管费", "IT 支出", 128000, "陈默"),
        ("2025-02-03", "春节福利采购", "行政支出", 64000, "刘倩"),
        ("2025-03-08", "设备采购（CT 机）", "固定资产", 4280000, "陈默"),
        ("2025-03-21", "差旅报销", "差旅费", 18600, "王恺"),
        ("2025-04-02", "培训场地租赁", "培训费", 52000, "李萌"),
        ("2025-04-19", "咨询费", "中介服务", 96000, "张岚"),
        ("2025-05-06", "办公耗材", "行政支出", 12400, "刘倩"),
        ("2025-06-11", "软件许可续费", "IT 支出", 210000, "陈默"),
    ]
    for d, s, k, a, who in data:
        rows.append([d, s, k, a, who])
    for m in range(7, 13):
        rows.append([f"2025-{m:02d}-15", f"{m} 月常规运营支出", "运营支出", 40000 + m * 1000, "刘倩"])
    xlsx_book([("2025支出台账", rows)], os.path.join(OUT, "财税_支出台账.xlsx"))

    docx_doc(
        "2025 年部门预算说明",
        [
            ("p", "本说明用于向管理层解释 2025 年预算安排，金额单位为万元。"),
            ("h1", "一、预算明细"),
            ("table", [
                ["科目", "预算", "上半年执行", "执行率"],
                ["培训费", "12", "5.2", "43%"],
                ["差旅费", "8", "3.1", "39%"],
                ["设备采购", "430", "428", "99%"],
                ["软件与云服务", "26", "21", "81%"],
            ]),
            ("h1", "二、需要说明的事项"),
            ("p", "培训费 12 万元中含外部讲师费用 4.2 万元，下半年计划追加实操工作坊一场。"),
            ("p", "设备采购集中在上半年完成，占全年预算的 99%，四季度不再安排同类采购。"),
        ],
        os.path.join(OUT, "财税_预算说明.docx"),
    )

    write(os.path.join(OUT, "财税_报销制度.md"),
          "# 财务报销制度\n\n"
          "## 一、适用范围\n本制度适用于公司全体员工的日常费用报销。\n\n"
          "## 二、报销时限\n员工应在费用发生之日起 30 日内提交报销申请，逾期需部门负责人书面说明。\n\n"
          "## 三、单笔金额要求\n单笔金额超过 5000 元的，需附合同或比价记录。\n\n"
          "## 四、审批流程\n申请人提交 → 直属主管审批 → 财务复核 → 出纳付款。\n\n"
          "## 五、票据要求\n发票抬头须为公司全称，税号须与营业执照一致。\n")

    r = Pdf()
    r.new_page()
    r.h1("2025 年第三季度财务摘要")
    r.p("本季度营业收入 3,180 万元，环比增长 12%；营业成本 1,540 万元，毛利率 51.6%。")
    r.h2("一、成本结构")
    r.table([["项目", "金额（万元）", "占比"],
             ["人力成本", "820", "53%"],
             ["设备折旧", "260", "17%"],
             ["运营支出", "180", "12%"],
             ["其他", "280", "18%"]], [200, 150, 120])
    r.h2("二、现金流")
    r.p("经营活动现金流净额 640 万元；期末货币资金 2,150 万元，可覆盖 4.1 个月运营支出。")
    r.h2("三、风险提示")
    r.p("设备采购集中在下半年，可能导致四季度资本开支超预算 15% 以内，已提请董事会关注。")
    r.save(os.path.join(OUT, "财税_季度摘要.pdf"))

    return [
        {"file": "财税_支出台账.xlsx", "domain": "财税", "format": "xlsx",
         "facts": {"最大单笔": "4,280,000", "最大单笔日期": "2025-03-08", "行数": str(len(rows) - 1)}},
        {"file": "财税_预算说明.docx", "domain": "财税", "format": "docx",
         "facts": {"培训费预算": "12 万元", "差旅费预算": "8 万元", "设备执行率": "99%"}},
        {"file": "财税_报销制度.md", "domain": "财税", "format": "md",
         "facts": {"报销时限": "30 日内", "大额起点": "5000 元"}},
        {"file": "财税_季度摘要.pdf", "domain": "财税", "format": "pdf",
         "facts": {"毛利率": "51.6%", "货币资金": "2,150 万元", "覆盖月数": "4.1"}},
    ]


# --------------------------------------------------------------- 技术 ------

def tech():
    write(os.path.join(OUT, "技术_运维手册.md"),
          "# 临床平台运维手册\n\n"
          "## 一、告警分级\n"
          "| 等级 | 含义 | 响应时限 | 升级对象 |\n"
          "| P0 | 全站不可用 | 5 分钟 | 值班经理 + CTO |\n"
          "| P1 | 核心接口错误率超过 5% | 15 分钟 | 当班组长 |\n"
          "| P2 | 单个机房容量告警 | 30 分钟 | 运维值班 |\n"
          "| P3 | 非核心功能降级 | 4 小时 | 排班处理 |\n"
          "| P4 | 例行巡检异常 | 次日 | 工单跟踪 |\n\n"
          "## 二、值班安排\n每周三 18:00 交接班，值班电话内线 8120。\n\n"
          "## 三、变更窗口\n生产变更只在周二、周四 22:00 至次日 02:00 执行，需提前一天申请。\n\n"
          "## 四、演练要求\n每季度组织一次故障演练，演练告警统一以 P5 编号标记，不进入真实告警统计。\n")

    write(os.path.join(OUT, "技术_接口文档.html"),
          "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
          "<title>患者主索引服务接口文档</title></head><body>"
          "<h1>患者主索引服务 API v2</h1>"
          "<p>基础地址：https://api.example-hospital.cn/pmi/v2</p>"
          "<h2>一、鉴权</h2><p>使用 Bearer Token，有效期 2 小时，过期后需重新获取。</p>"
          "<h2>二、重试策略</h2><p>客户端在网络错误时最多自动重试 3 次，间隔按指数退避，首次 200 毫秒。</p>"
          "<h2>三、限流</h2><p>单租户限流 100 rps，超出返回 429，同时返回 Retry-After 头。</p>"
          "<h2>四、超时</h2><p>服务端超时 30 秒，客户端建议设置为 35 秒以留出重试余量。</p>"
          "<h2>五、错误码</h2>"
          "<table border=\"1\"><tr><th>错误码</th><th>含义</th></tr>"
          "<tr><td>40001</td><td>缺少必填参数</td></tr>"
          "<tr><td>40901</td><td>患者已存在</td></tr>"
          "<tr><td>50301</td><td>下游 HIS 不可用</td></tr></table>"
          "</body></html>")

    docx_doc(
        "平台架构说明",
        [
            ("p", "本文说明临床数据平台的部署架构与容灾设计。"),
            ("h1", "一、机房"),
            ("p", "生产环境部署于上海、杭州、贵阳三个机房，两地三中心结构，上海为主中心。"),
            ("h1", "二、切换指标"),
            ("table", [["指标", "目标"], ["RTO（恢复时间）", "5 分钟"], ["RPO（数据丢失）", "0"]]),
            ("h1", "三、数据同步"),
            ("p", "主从复制采用半同步方式，跨机房延迟控制在 200 毫秒以内。"),
        ],
        os.path.join(OUT, "技术_架构说明.docx"),
    )

    write(os.path.join(OUT, "技术_值班记录.csv"),
          "日期,班次,值班人,事项,状态\n"
          "2025-09-01,夜班,陈默,P0 演练,P5-2025-03\n"
          "2025-09-02,夜班,刘倩,例行巡检,正常\n"
          "2025-09-03,白班,王恺,接口 429 增多,已限流\n"
          "2025-09-04,白班,李萌,作废记录,作废\n"
          "2025-09-05,夜班,陈默,数据库主从延迟,已恢复\n")

    return [
        {"file": "技术_运维手册.md", "domain": "技术", "format": "md",
         "facts": {"告警等级数": "5", "演练编号": "P5", "值班电话": "8120", "变更窗口": "周二、周四"}},
        {"file": "技术_接口文档.html", "domain": "技术", "format": "html",
         "facts": {"重试次数": "3 次", "限流": "100 rps", "超时": "30 秒", "Token 有效期": "2 小时"}},
        {"file": "技术_架构说明.docx", "domain": "技术", "format": "docx",
         "facts": {"机房数": "3", "RTO": "5 分钟", "主中心": "上海"}},
        {"file": "技术_值班记录.csv", "domain": "技术", "format": "csv",
         "facts": {"作废行": "2025-09-04", "行数": "5"}},
    ]


# --------------------------------------------------------------- 医疗 ------

def medical():
    m = Pdf()
    m.new_page()
    m.h1("门诊病历")
    m.p("患者：周某，男，34 岁　　就诊日期：2025 年 8 月 12 日　　门诊号：MZ2025081201")
    m.p("主诉：发热伴咽痛 3 天。现病史：患者 3 天前受凉后出现发热，最高体温 38.6℃，伴咽痛、乏力。")
    m.h2("一、体格检查")
    m.p("体温 38.6℃，脉搏 96 次/分，血压 118/76 mmHg，咽部充血，扁桃体 II 度肿大。")
    m.new_page()
    m.h2("二、辅助检查")
    m.p("血常规：白细胞 11.2×10⁹/L，中性粒细胞比例 78%，C 反应蛋白 26 mg/L。")
    m.h2("三、初步诊断")
    m.p("急性上呼吸道感染（细菌感染可能）。")
    m.new_page()
    m.h2("四、处置与处方")
    m.p("1. 布洛芬缓释胶囊 0.3g，口服，每日三次，连用 3 天。")
    m.p("2. 阿莫西林胶囊 0.5g，口服，每日三次，连用 5 天。")
    m.p("3. 多饮水、休息，三日后复诊；体温超过 39℃ 或出现呼吸困难随时就诊。")
    m.h2("五、医师签名")
    m.p("接诊医师：林医生　　科室：呼吸内科　　打印时间：2025-08-12 16:40")
    m.save(os.path.join(OUT, "医疗_门诊病历.pdf"))

    docx_doc(
        "用药说明",
        [
            ("p", "本说明随处方发放，供患者阅读。"),
            ("h1", "一、布洛芬缓释胶囊"),
            ("p", "规格 0.3g，每日三次，餐后服用，连续使用不超过 3 天。"),
            ("h1", "二、阿莫西林胶囊"),
            ("p", "规格 0.5g，每日三次，连续 5 天，青霉素过敏者禁用。"),
            ("h1", "三、注意事项"),
            ("p", "两种药物间隔 30 分钟以上服用；出现皮疹、腹泻加重请停药并联系医生。"),
        ],
        os.path.join(OUT, "医疗_用药说明.docx"),
    )

    xlsx_book([("检验指标", [
        ["项目", "结果", "参考范围", "结论"],
        ["白细胞", "11.2", "3.5-9.5", "偏高"],
        ["中性粒细胞比例", "78", "40-75", "偏高"],
        ["C 反应蛋白", "26", "0-10", "偏高"],
        ["ALT", "68", "0-40", "偏高"],
        ["血糖", "5.4", "3.9-6.1", "正常"],
    ])], os.path.join(OUT, "医疗_检验指标.xlsx"))

    write(os.path.join(OUT, "医疗_随访记录.md"),
          "# 随访记录\n\n"
          "## 第 1 次随访（2025-08-15）\n体温 36.8℃，咽痛缓解，继续原方案。\n\n"
          "## 第 2 次随访（2025-08-19）\n体温正常，咳嗽轻微，停用阿莫西林。\n\n"
          "## 第 3 次随访（2025-08-26）\n症状消失，复查血常规白细胞 7.1×10⁹/L，已恢复正常。\n")

    return [
        {"file": "医疗_门诊病历.pdf", "domain": "医疗", "format": "pdf",
         "facts": {"最高体温": "38.6", "诊断": "急性上呼吸道感染", "门诊号": "MZ2025081201", "复诊间隔": "三日"}},
        {"file": "医疗_用药说明.docx", "domain": "医疗", "format": "docx",
         "facts": {"布洛芬规格": "0.3g", "阿莫西林疗程": "5 天", "间隔": "30 分钟"}},
        {"file": "医疗_检验指标.xlsx", "domain": "医疗", "format": "xlsx",
         "facts": {"超标项数": "4", "ALT": "68", "血糖": "5.4"}},
        {"file": "医疗_随访记录.md", "domain": "医疗", "format": "md",
         "facts": {"随访次数": "3", "末次日期": "2025-08-26", "末次白细胞": "7.1"}},
    ]


# --------------------------------------------------------------- 政府 ------

def government():
    g = Pdf()
    g.new_page()
    g.h1("关于开展 2026 年度专项资金申报的通知")
    g.p("各有关单位：为支持临床数据平台建设，现开展 2026 年度专项资金申报工作，有关事项通知如下。")
    g.h2("一、申报条件")
    g.p("申报单位须在本市注册满两年，且上年度营业收入不低于 1000 万元。")
    g.h2("二、申报时间")
    g.p("线上申报系统开放时间为 2025 年 10 月 8 日至 2025 年 11 月 30 日，逾期不予受理。")
    g.new_page()
    g.h2("三、材料要求")
    g.p("申报材料包括：申请书、营业执照、上年度审计报告、项目可行性方案，均需加盖公章。")
    g.h2("四、评审与公示")
    g.p("评审结果将于 2025 年 12 月 20 日前公示，公示期 5 个工作日。")
    g.save(os.path.join(OUT, "政府_申报通知.pdf"))

    write(os.path.join(OUT, "政府_办事指南.html"),
          "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
          "<title>专项资金申报办事指南</title></head><body>"
          "<h1>专项资金申报办事指南</h1>"
          "<h2>一、办理流程</h2><p>注册账号 → 在线填报 → 上传材料 → 形式审查 → 专家评审 → 公示 → 拨付。</p>"
          "<h2>二、办理时限</h2><p>形式审查 3 个工作日，专家评审 15 个工作日。</p>"
          "<h2>三、咨询方式</h2><p>咨询电话：021-12345678（工作日 9:00-17:00）。</p>"
          "<h2>四、材料清单</h2>"
          "<table border=\"1\"><tr><th>序号</th><th>材料</th><th>份数</th></tr>"
          "<tr><td>1</td><td>申请书</td><td>1</td></tr>"
          "<tr><td>2</td><td>营业执照</td><td>1</td></tr>"
          "<tr><td>3</td><td>审计报告</td><td>1</td></tr></table>"
          "</body></html>")

    docx_doc(
        "第 9 次项目推进会议纪要",
        [
            ("p", "会议时间：2025 年 9 月 12 日 14:00　　地点：三楼会议室　　主持：赵主任"),
            ("h1", "一、议定事项"),
            ("p", "1. 由信息中心负责在 9 月 30 日前完成申报材料初稿。"),
            ("p", "2. 财务部核对上年度审计报告口径，10 月 10 日前反馈。"),
            ("p", "3. 法务部审核承诺函文本，删除与现行制度冲突的表述。"),
            ("h1", "二、下次会议"),
            ("p", "定于 2025 年 10 月 9 日召开第 10 次会议，汇报材料准备进度。"),
        ],
        os.path.join(OUT, "政府_会议纪要.docx"),
    )

    xlsx_book([("预算表", [
        ["项目", "金额（万元）", "占比"],
        ["平台建设", "750", "60%"],
        ["设备采购", "300", "24%"],
        ["人员经费", "150", "12%"],
        ["其他", "50", "4%"],
        ["合计", "1250", "100%"],
    ])], os.path.join(OUT, "政府_预算表.xlsx"))

    return [
        {"file": "政府_申报通知.pdf", "domain": "政府", "format": "pdf",
         "facts": {"截止日期": "2025 年 11 月 30 日", "营收门槛": "1000 万元", "公示日期": "2025 年 12 月 20 日"}},
        {"file": "政府_办事指南.html", "domain": "政府", "format": "html",
         "facts": {"咨询电话": "021-12345678", "形式审查": "3 个工作日", "专家评审": "15 个工作日"}},
        {"file": "政府_会议纪要.docx", "domain": "政府", "format": "docx",
         "facts": {"议定事项": "3", "下次会议": "2025 年 10 月 9 日", "初稿截止": "9 月 30 日"}},
        {"file": "政府_预算表.xlsx", "domain": "政府", "format": "xlsx",
         "facts": {"合计": "1250", "平台建设占比": "60%"}},
    ]


# --------------------------------------------------------------- 培训 ------

def training():
    slides = [
        ("临床数据平台培训（2025 秋季班）", "讲师：陈默　　课时：8 学时"),
        ("1. 课程概览", ["1.1 培训目标", "1.2 考核方式", "1.3 课程安排"]),
        ("2. 数据治理基础", ["2.1 数据分级", "2.2 元数据管理", "2.3 数据质量规则"]),
        ("3. 平台操作", ["3.1 登录与权限", "3.2 数据脱敏", "3.3 数据导出"]),
        ("4. 报表与看板", ["4.1 指标口径", "4.2 看板配置"]),
        ("5. 常见问题", ["5.1 权限申请", "5.2 导出失败排查"]),
        ("6. 考核", ["6.1 上机操作", "6.2 笔试"]),
    ]
    # Slide 7 must be "3.2 数据脱敏": cover + 6 content slides puts it here, but
    # the deck above only has 7; pad so that the题目 lands on a predictable slide.
    slides = [
        ("临床数据平台培训（2025 秋季班）", "讲师：陈默　　课时：8 学时"),
        ("1. 课程概览", ["1.1 培训目标", "1.2 考核方式", "1.3 课程安排"]),
        ("2. 数据治理基础", ["2.1 数据分级", "2.2 元数据管理"]),
        ("2. 数据治理基础（续）", ["2.3 数据质量规则", "2.4 主数据管理"]),
        ("3. 平台操作", ["3.1 登录与权限"]),
        ("3. 平台操作（续）", ["3.2 数据脱敏"]),
        ("4. 报表与看板", ["4.1 指标口径", "4.2 看板配置"]),
        ("5. 常见问题", ["5.1 权限申请", "5.2 导出失败排查"]),
        ("6. 考核", ["6.1 上机操作", "6.2 笔试"]),
        ("7. 附录", ["7.1 术语表", "7.2 联系方式"]),
        ("8. 结业安排", ["8.1 证书发放", "8.2 后续支持"]),
        ("9. 结束", ["谢谢"]),
    ]
    pptx_deck(slides, os.path.join(OUT, "培训_课程大纲.pptx"))

    rows = [["序号", "姓名", "部门", "笔试", "上机"]]
    names = [("李娜", "技术部", 92, 88), ("王强", "财务部", 71, 65), ("李娜", "行政部", 58, 49),
             ("赵敏", "信息中心", 85, 90), ("孙磊", "技术部", 66, 72), ("周颖", "医务处", 78, 81)]
    for i, (n, d, w, s) in enumerate(names, start=1):
        rows.append([i, n, d, w, s])
    for i in range(len(names) + 1, 39):
        rows.append([i, f"学员{i:02d}", "临床科室", 60 + (i % 35), 55 + (i % 40)])
    xlsx_book([("学员名单", rows)], os.path.join(OUT, "培训_学员名单.xlsx"))

    write(os.path.join(OUT, "培训_试题.md"),
          "# 结业笔试题（节选）\n\n"
          "1. 患者数据分级中，身份证号属于哪一级？\n"
          "2. 数据导出前必须完成的步骤是什么？\n"
          "3. 权限申请的审批链路包括哪些角色？\n"
          "4. 看板指标口径由哪个部门维护？\n"
          "5. 导出失败的常见原因有哪些？\n")

    docx_doc(
        "结业说明",
        [
            ("p", "本期培训共 38 名学员，结业标准为笔试与上机均不低于 60 分。"),
            ("h1", "一、成绩构成"),
            ("p", "笔试占 60%，上机占 40%，总分 60 分及以上为合格。"),
            ("h1", "二、证书"),
            ("p", "合格学员于 2025 年 10 月 20 日起可领取电子证书。"),
        ],
        os.path.join(OUT, "培训_结业说明.docx"),
    )

    return [
        {"file": "培训_课程大纲.pptx", "domain": "培训", "format": "pptx",
         "facts": {"节数": "12", "第 6 页标题": "3. 平台操作（续）", "脱敏所在页": "sl.6"}},
        {"file": "培训_学员名单.xlsx", "domain": "培训", "format": "xlsx",
         "facts": {"学员数": "38", "同名": "李娜（技术部/行政部）", "李娜技术部笔试": "92"}},
        {"file": "培训_试题.md", "domain": "培训", "format": "md",
         "facts": {"题数": "5", "占比": "笔试 60%"}},
        {"file": "培训_结业说明.docx", "domain": "培训", "format": "docx",
         "facts": {"合格线": "60 分", "证书日期": "2025 年 10 月 20 日"}},
    ]


# ---------------------------------------------------------- 压力/边界 ------

def stress():
    spec = Pdf()
    spec.new_page()
    spec.h1("数据平台技术规范（完整版）")
    spec.p("本规范共 60 页，用于压力测试：问题会指向靠后的章节。")
    chapters = ["总则", "术语", "总体架构", "数据模型", "接口规范", "性能指标", "安全要求",
                "备份策略", "容灾", "运维", "附录"]
    for page in range(2, 61):
        spec.new_page()
        name = chapters[(page - 2) % len(chapters)]
        spec.h2(f"第 {page} 页　{name}")
        for k in range(1, 6):
            spec.p(f"{page}.{k} 本节说明{name}的第 {k} 项要求，适用于所有接入系统，"
                   f"不满足者需在评审阶段提出偏离说明并获批。")
        if page == 45:
            spec.p("4.7 备份策略：全量备份每周一次，增量备份每日一次，保留 90 天；"
                   "异地副本保存在贵阳机房，恢复演练每季度一次。")
    spec.save(os.path.join(OUT, "技术_规范全文.pdf"))

    scan_pdf([
        "会议签到表（扫描件）",
        "时间：2025 年 9 月 12 日",
        "地点：三楼会议室",
        "出席：赵主任、陈默、王恺、李萌、刘倩",
    ], os.path.join(OUT, "政府_签到表_扫描件.pdf"))

    return [
        {"file": "技术_规范全文.pdf", "domain": "技术", "format": "pdf",
         "facts": {"页数": "60", "备份策略页": "p.45", "全量备份": "每周一次", "增量备份": "每日一次", "保留": "90 天"}},
        {"file": "政府_签到表_扫描件.pdf", "domain": "政府", "format": "pdf-scan",
         "facts": {"文本层": "无", "应提示": "需要 OCR"}},
    ]


def main():
    clean()
    docs = []
    for build in (legal, finance, tech, medical, government, training):
        docs.extend(build())
    docs.extend(stress())

    truth = {
        "generated": "make-corpus2.py",
        "docs": docs,
        "total": len(docs),
    }
    with open(os.path.join(HERE, "corpus2.truth.json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False, indent=2)

    size = sum(os.path.getsize(os.path.join(OUT, d["file"])) for d in docs)
    print(f"{len(docs)} docs, {size / 1024:.0f} KB")
    for d in docs:
        p = os.path.join(OUT, d["file"])
        print(f"  {'OK ' if os.path.exists(p) else 'MISS'} {d['file']}  {os.path.getsize(p) / 1024:.0f} KB")


if __name__ == "__main__":
    sys.exit(main())
