# -*- coding: utf-8 -*-
"""Generate test fixtures for Folio.

Outputs (into tests/fixtures/):
  合同A_主合同.pdf       ~40 pages, CJK, tables on p3 and p7, 付款条款 on p12
  合同B_补充协议.pdf      6 pages, modifies 12.1
  付款条款_内部说明.docx   short docx, no pagination (block index instead)

Run:  python tests/make-fixtures.py
"""
from __future__ import annotations

import os
from pathlib import Path

import fitz  # PyMuPDF

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)

FONT = r"C:\Windows\Fonts\simhei.ttf"
PAGE_W, PAGE_H = 595, 842  # A4
MARGIN_L, MARGIN_R = 72, 72
MARGIN_T, MARGIN_B = 64, 64
FONT_SIZE = 10.5
LINE_H = 17.0
BODY_W = PAGE_W - MARGIN_L - MARGIN_R
# CJK glyph advance is ~1.0em at this size; keep a conservative wrap width.
WRAP = int(BODY_W / FONT_SIZE) - 2


def wrap(text: str, width: int = WRAP) -> list[str]:
    """Wrap CJK-ish text by display width (CJK=2 cols handled as 1 char each)."""
    out: list[str] = []
    for raw in text.split("\n"):
        if not raw:
            out.append("")
            continue
        cur = ""
        for ch in raw:
            cur += ch
            if len(cur) >= width:
                out.append(cur)
                cur = ""
        if cur:
            out.append(cur)
    return out


class Doc:
    def __init__(self, title: str, footer: str):
        self.doc = fitz.open()
        self.title = title
        self.footer = footer
        self.page = None
        self.y = 0.0
        self.page_no = 0
        self.starts: dict[str, int] = {}
        self.new_page()

    # -- page management ---------------------------------------------------
    def new_page(self) -> None:
        self.page = self.doc.new_page(width=PAGE_W, height=PAGE_H)
        self.page_no += 1
        self.page.insert_font(fontname="F0", fontfile=FONT)
        self.page.insert_text(
            (MARGIN_L, 40), self.title, fontname="F0", fontsize=8, color=(0.45, 0.45, 0.45)
        )
        self.page.insert_text(
            (PAGE_W / 2 - 10, PAGE_H - 36),
            f"- {self.page_no} -",
            fontname="F0",
            fontsize=9,
            color=(0.4, 0.4, 0.4),
        )
        self.y = MARGIN_T

    def need(self, h: float) -> None:
        if self.y + h > PAGE_H - MARGIN_B:
            self.new_page()

    # -- blocks ------------------------------------------------------------
    def h1(self, text: str, new_page: bool = False) -> None:
        if new_page:
            self.new_page()
        self.need(3 * LINE_H)
        self.starts.setdefault(text, self.page_no)
        self.y += 6
        self.page.insert_text((MARGIN_L, self.y), text, fontname="F0", fontsize=14)
        self.y += LINE_H + 6

    def h2(self, text: str) -> None:
        self.need(2 * LINE_H)
        self.page.insert_text((MARGIN_L + 14, self.y), text, fontname="F0", fontsize=11)
        self.y += LINE_H + 2

    def p(self, text: str, indent: int = 0) -> None:
        for line in wrap(text):
            self.need(LINE_H)
            if line:
                self.page.insert_text(
                    (MARGIN_L + indent, self.y), line, fontname="F0", fontsize=FONT_SIZE
                )
            self.y += LINE_H

    def kv_table(self, rows: list[tuple[str, str]], col1: int = 110) -> None:
        """Two-column bordered table: term | definition."""
        x0, x1 = MARGIN_L, PAGE_W - MARGIN_R
        self.need(LINE_H * len(rows) * 1.6 + 10)
        y = self.y
        for term, desc in rows:
            lines = wrap(desc, width=int((x1 - x0 - col1) / FONT_SIZE) - 2)
            h = max(LINE_H, LINE_H * len(lines))
            rect = fitz.Rect(x0, y, x1, y + h)
            self.page.draw_rect(rect, color=(0.3, 0.3, 0.3), width=0.6)
            self.page.draw_line(
                fitz.Point(x0 + col1, y), fitz.Point(x0 + col1, y + h), color=(0.3, 0.3, 0.3), width=0.6
            )
            self.page.insert_text(
                (x0 + 6, y + 12), term, fontname="F0", fontsize=FONT_SIZE
            )
            for i, line in enumerate(lines):
                self.page.insert_text(
                    (x0 + col1 + 6, y + 12 + i * LINE_H), line, fontname="F0", fontsize=FONT_SIZE
                )
            y += h
        self.y = y + 8

    def pay_table(self, rows: list[tuple[str, str, str, str]]) -> None:
        """Four-column bordered table: 节点 | 比例 | 金额 | 期限."""
        x0, x1 = MARGIN_L, PAGE_W - MARGIN_R
        widths = [150, 70, 110, x1 - x0 - 330]
        head = ("支付节点", "比例", "金额（元）", "付款期限")
        n = len(rows) + 1
        self.need(LINE_H * n + 10)
        y = self.y
        x = x0
        for w, htxt in zip(widths, head):
            self.page.draw_rect(fitz.Rect(x, y, x + w, y + LINE_H), color=(0.3, 0.3, 0.3), width=0.6)
            self.page.insert_text((x + 5, y + 12), htxt, fontname="F0", fontsize=FONT_SIZE)
            x += w
        y += LINE_H
        for r in rows:
            x = x0
            for w, cell in zip(widths, r):
                self.page.draw_rect(
                    fitz.Rect(x, y, x + w, y + LINE_H), color=(0.3, 0.3, 0.3), width=0.6
                )
                self.page.insert_text((x + 5, y + 12), cell, fontname="F0", fontsize=FONT_SIZE)
                x += w
            y += LINE_H
        self.y = y + 10

    def save(self, name: str) -> Path:
        path = OUT / name
        try:
            self.doc.subset_fonts()
        except Exception:
            pass
        self.doc.save(path, garbage=4, deflate=True)
        self.doc.close()
        return path


# ---------------------------------------------------------------------------
# 合同 A：主合同（~40 页）
# ---------------------------------------------------------------------------
def build_contract_a() -> Path:
    d = Doc("技术服务合同（主合同）   合同编号：HT-2024-0871", "HT-2024-0871")

    # p1 封面
    y = 220
    d.page.insert_text((MARGIN_L + 90, y), "技 术 服 务 合 同", fontname="F0", fontsize=26)
    d.page.insert_text((MARGIN_L + 120, y + 46), "（主合同）", fontname="F0", fontsize=15)
    for i, t in enumerate(
        [
            "合同编号：HT-2024-0871",
            "甲方：浙江海临智能装备有限公司",
            "乙方：宁波承远信息技术服务有限公司",
            "签订地点：浙江省宁波市",
            "签订日期：2024 年 3 月 18 日",
        ]
    ):
        d.page.insert_text((MARGIN_L + 60, y + 120 + i * 24), t, fontname="F0", fontsize=12)
    d.new_page()

    # p2 目录
    d.h1("目 录")
    toc = [
        ("第一条  定义", 3),
        ("第二条  服务范围", 4),
        ("第三条  服务标准与验收", 5),
        ("第四条  合同价款", 6),
        ("第五条  支付计划", 7),
        ("第六条  甲方的权利与义务", 8),
        ("第七条  乙方的权利与义务", 9),
        ("第八条  知识产权", 10),
        ("第九条  保密", 11),
        ("第十二条  付款条款", 12),
        ("第十三条  发票与税务", 14),
        ("第十四条  违约责任", 15),
        ("第十五条  不可抗力", 17),
        ("第十六条  合同变更与解除", 18),
        ("第十七条  争议解决", 19),
        ("第十八条  其他约定", 20),
        ("附件一  服务清单", 21),
        ("附件二  验收标准", 27),
        ("附件三  数据处理与安全要求", 33),
        ("签署页", 40),
    ]
    for name, pg in toc:
        d.page.insert_text((MARGIN_L + 10, d.y), name, fontname="F0", fontsize=FONT_SIZE)
        d.page.insert_text((PAGE_W - MARGIN_R - 30, d.y), str(pg), fontname="F0", fontsize=FONT_SIZE)
        d.y += LINE_H + 1

    # p3 第一条 定义 + 术语表
    d.h1("第一条  定义", new_page=True)
    d.p(
        "1.1  在本合同中，除非上下文另有说明，下列术语具有本条所赋予的含义。本条所列定义适用于本合同正文、附件以及双方就本合同签署的一切补充文件。"
    )
    d.p("1.2  本合同项下的术语定义如下表所示：")
    d.kv_table(
        [
            ("服务", "乙方依据本合同向甲方提供的系统集成、部署实施、数据迁移、培训与运维支持等全部工作。"),
            ("交付物", "乙方在履行服务过程中应向甲方提交的文档、代码、配置文件、测试报告及其他成果。"),
            ("验收", "甲方依据附件二所列标准对交付物进行确认的过程，分为初验与终验两个阶段。"),
            ("工作日", "中华人民共和国法定工作日，不包括法定节假日与休息日。"),
            ("保密信息", "一方以书面、口头、电子或其他形式向另一方披露的、标注或应合理认定为保密的信息。"),
            ("关联方", "直接或间接控制一方、被一方控制或与一方受共同控制的任何主体。"),
        ]
    )
    d.p(
        "1.3  本条定义如与附件中的定义不一致，以本合同正文的定义为准；附件之间不一致的，以附件一为准。"
    )

    # p4 第二条
    d.h1("第二条  服务范围", new_page=True)
    d.p("2.1  乙方应按照本合同及附件一的约定，向甲方提供下列服务：")
    for t in [
        "（1）智能制造执行系统（MES）的现场部署与参数配置；",
        "（2）既有 ERP 系统与 MES 之间的接口开发与联调；",
        "（3）历史生产数据的数据清洗、迁移与校验；",
        "（4）面向甲方生产、质量、仓储三个部门的使用培训；",
        "（5）上线后十二个月的系统运维与故障响应。",
    ]:
        d.p(t, indent=14)
    d.p(
        "2.2  服务的具体范围、工作量与技术指标以附件一《服务清单》为准。附件一未列明的事项，双方应另行签署补充协议，未经书面确认，乙方无义务提供。"
    )
    d.p(
        "2.3  乙方应在合同生效后十个工作日内提交项目实施计划，实施计划经甲方书面确认后作为履行依据。甲方在收到实施计划后五个工作日内未提出书面异议的，视为确认。"
    )

    # p5 第三条
    d.h1("第三条  服务标准与验收", new_page=True)
    d.p(
        "3.1  乙方提供的服务应符合国家标准、行业标准以及附件二所列的技术指标。上述标准不一致的，以较高者为准。"
    )
    d.p(
        "3.2  初验：乙方完成部署并完成内部测试后，向甲方提交初验申请及测试报告。甲方应在收到申请后十个工作日内组织初验。初验不合格的，乙方应在十五个工作日内完成整改并重新申请初验。"
    )
    d.p(
        "3.3  终验：系统连续稳定运行三十个自然日后，乙方可申请终验。终验以附件二所列全部指标达标为通过条件。终验通过之日为验收合格日。"
    )
    d.p(
        "3.4  甲方无正当理由拖延验收超过三十个工作日的，视为验收合格，但不免除乙方在质量保证期内的瑕疵担保责任。"
    )

    # p6 第四条
    d.h1("第四条  合同价款", new_page=True)
    d.p("4.1  本合同为固定总价合同，合同总价款为人民币壹佰捌拾陆万元整（￥1,860,000.00）。")
    d.p(
        "4.2  前款价款包含乙方为履行本合同所发生的人工、差旅、软硬件采购、第三方许可及税费以外的全部费用。除本合同另有约定或双方另行书面确认外，甲方无需支付任何其他费用。"
    )
    d.p(
        "4.3  因甲方原因导致服务范围变更的，双方应就增加的工作量另行协商，并签署书面变更确认单。变更确认单经双方授权代表签字后生效，作为本合同不可分割的组成部分。"
    )

    # p7 第五条 支付计划 + 表
    d.h1("第五条  支付计划", new_page=True)
    d.p("5.1  合同价款的支付按下列节点执行：")
    d.pay_table(
        [
            ("合同生效预付款", "30%", "558,000.00", "合同生效后 10 个工作日内"),
            ("初验合格款", "30%", "558,000.00", "初验合格后 10 个工作日内"),
            ("终验合格款", "30%", "558,000.00", "终验合格后 30 日内"),
            ("质保金", "10%", "186,000.00", "质保期满后 30 日内"),
        ]
    )
    d.p(
        "5.2  上表所列付款比例与金额为原则性安排，具体付款条件、发票要求及逾期处理适用第十二条《付款条款》的约定；二者不一致时，以第十二条为准。"
    )
    d.p(
        "5.3  甲方每次付款前，乙方应提交等额有效的增值税专用发票。发票内容应与本合同项下的服务名称一致。"
    )

    # p8 第六条
    d.h1("第六条  甲方的权利与义务", new_page=True)
    d.p(
        "6.1  甲方应按约定向乙方提供实施所必需的环境、数据、接口文档及人员配合，并指定一名项目负责人作为日常联络人。"
    )
    d.p(
        "6.2  甲方有权对乙方的服务过程进行监督与检查，有权要求乙方更换不能胜任工作的实施人员，但应提前五个工作日书面说明理由。"
    )
    d.p(
        "6.3  甲方应保证其提供给乙方的数据来源合法，不侵犯任何第三方的权利。因甲方提供的数据引发争议的，由甲方承担相应责任。"
    )

    # p9 第七条
    d.h1("第七条  乙方的权利与义务", new_page=True)
    d.p(
        "7.1  乙方应按本合同约定的进度、标准完成服务，并保证实施人员具备相应的资质与经验。"
    )
    d.p(
        "7.2  乙方不得将本合同项下的主要义务分包或转包给第三方。确需分包的，应事先取得甲方书面同意，且乙方仍对分包部分承担全部责任。"
    )
    d.p(
        "7.3  乙方应遵守甲方现场的安全生产、信息安全管理规定。因乙方人员违反上述规定造成损失的，由乙方承担赔偿责任。"
    )

    # p10 第八条
    d.h1("第八条  知识产权", new_page=True)
    d.p(
        "8.1  乙方为履行本合同专门开发的定制化代码、文档及配置文件的著作权归甲方所有；乙方在本合同签订前已拥有的通用组件、框架、工具及其后续改进，著作权仍归乙方所有。"
    )
    d.p(
        "8.2  乙方授予甲方在前款通用组件上永久的、不可撤销的、免许可费的使用权，使用范围限于甲方及其关联方为本合同项下系统之运营目的。"
    )
    d.p("8.3  任何一方不得擅自使用对方的商标、商号或标识进行宣传，经书面同意的除外。")

    # p11 第九条
    d.h1("第九条  保密", new_page=True)
    d.p(
        "9.1  双方对因履行本合同而知悉的对方保密信息负有保密义务，保密期限自本合同签署之日起至合同终止后五年止。"
    )
    d.p(
        "9.2  下列信息不属于保密信息：接收方在披露前已合法知悉的；非因接收方违约而进入公有领域的；接收方自第三方合法取得且不负有保密义务的；接收方独立开发且未使用披露方保密信息的。"
    )
    d.p(
        "9.3  因法律法规、司法机关或监管机构要求而披露的，接收方应在法律允许的范围内事先通知披露方，并将披露范围限制在要求的最小限度内。"
    )

    # p12 第十二条 付款条款 —— 核心
    d.h1("第十二条  付款条款", new_page=True)
    d.p(
        "12.1  甲方应在收到乙方开具的合规增值税专用发票及相应验收单据后三十（30）日内，以银行转账方式支付对应节点的合同价款。乙方提交的单据不齐备或存在错误的，付款期限自甲方书面提出补正要求之日起重新计算。"
    )
    d.p(
        "12.2  乙方收款账户信息如下：户名 宁波承远信息技术服务有限公司；开户行 中国银行宁波市江东支行；账号 3901 5588 0012 3456。乙方变更账户信息的，应提前十个工作日以加盖公章的书面形式通知甲方，未经书面通知，甲方按原账户付款即视为履行完毕。"
    )
    d.p(
        "12.3  甲方逾期付款的，每逾期一日按逾期金额的万分之五向乙方支付违约金，逾期超过六十日的，乙方有权暂停服务并书面通知甲方；暂停期间不计入乙方履约期限，由此产生的工期顺延乙方不承担责任。"
    )
    d.p(
        "12.4  乙方逾期提交发票或验收单据的，每逾期一日按对应金额的万分之三向甲方支付违约金，但因甲方未按期组织验收导致的除外。"
    )
    d.p(
        "12.5  双方对付款金额存在争议的，无争议部分应按期支付，争议部分待双方协商或依第十七条解决后支付，甲方不得以争议为由拒付全部价款。"
    )

    d.h2("12.6  付款条件细则")
    d.p("（1）预付款：合同生效并以双方盖章的合同正本各执两份后支付，乙方应同时提交履约保函或同等效力的担保。", indent=14)
    d.p("（2）初验款：初验报告经甲方项目负责人与技术负责人双签后支付。", indent=14)
    d.p("（3）终验款：终验报告经甲方分管领导批准后支付。", indent=14)
    d.p("（4）质保金：质保期届满且无未决质量问题后支付，甲方可从中扣除已经确认的违约金。", indent=14)

    # p13 付款条款续
    d.new_page()
    d.h2("12.7  发票要求")
    d.p(
        "乙方开具的发票应符合下列要求：发票抬头与甲方营业执照名称一致；税率与合同约定的服务类别相符；发票备注栏应注明合同编号 HT-2024-0871 及对应付款节点。发票不符合上述要求的，甲方有权拒收，付款期限自换开合规发票之日起重新计算。"
    )
    d.h2("12.8  付款方式的限制")
    d.p(
        "除双方另有书面约定外，甲方不得以商业承兑汇票、供应链票据或其他非现金方式支付合同价款。确需以票据方式支付的，应经乙方书面同意，且贴现费用由甲方承担。"
    )
    d.h2("12.9  抵销")
    d.p(
        "甲方主张抵销的，应提供经双方确认的债权凭证。未经乙方书面确认，甲方不得单方抵销本合同项下的应付款项，亦不得以对乙方关联方的债权主张抵销。"
    )

    # p14 第十三条
    d.h1("第十三条  发票与税务", new_page=True)
    d.p(
        "13.1  本合同价款为含税价，增值税税率为 6%。国家调整税率或税收政策的，双方应按调整后的税率执行，合同不含税价保持不变。"
    )
    d.p(
        "13.2  因一方未依法纳税或开具不合规发票导致另一方损失的，责任方应予赔偿，包括但不限于补缴税款、滞纳金、罚款及合理的律师费。"
    )

    # p15-16 第十四条
    d.h1("第十四条  违约责任", new_page=True)
    d.p(
        "14.1  任何一方违反本合同约定，应在收到对方书面通知后十五个工作日内纠正；逾期未纠正的，应承担违约责任。"
    )
    d.p(
        "14.2  乙方逾期交付的，每逾期一日按合同总价款的万分之三支付违约金，累计不超过合同总价款的百分之十。逾期超过六十日的，甲方有权解除合同并要求乙方返还已付款项。"
    )
    d.p(
        "14.3  因乙方交付物存在缺陷导致甲方生产中断的，乙方应赔偿甲方因此遭受的直接经济损失，赔偿总额以合同总价款为限。"
    )
    d.p(
        "14.4  除本合同另有明确约定外，任何一方不对对方的间接损失、可得利益损失、商誉损失承担赔偿责任。"
    )
    d.new_page()
    d.h2("14.5  责任限额的例外")
    d.p(
        "下列情形不适用第 14.3 条与第 14.4 条的责任限额：故意或重大过失；侵犯第三方知识产权；违反保密义务；违反第九条与附件三关于数据安全的规定。"
    )

    # p17 第十五条
    d.h1("第十五条  不可抗力", new_page=True)
    d.p(
        "15.1  因不可抗力致使一方不能履行或不能完全履行本合同的，该方应在事件发生后五个工作日内书面通知对方，并在合理期限内提供有权机构出具的证明。"
    )
    d.p(
        "15.2  不可抗力持续超过九十日，致使合同目的不能实现的，任何一方均有权解除合同，双方按已履行部分结算，互不承担违约责任。"
    )

    # p18 第十六条
    d.h1("第十六条  合同变更与解除", new_page=True)
    d.p(
        "16.1  本合同的任何变更均应采用书面形式，经双方授权代表签字并加盖公章后生效。口头承诺、往来邮件中的意向性表述不构成变更。"
    )
    d.p(
        "16.2  有下列情形之一的，守约方有权书面通知解除本合同：一方严重违约且在催告期内未纠正；一方进入破产、清算程序；一方营业执照被吊销。"
    )
    d.p("16.3  合同解除不影响保密、知识产权、争议解决条款的效力。")

    # p19 第十七条
    d.h1("第十七条  争议解决", new_page=True)
    d.p(
        "17.1  因本合同引起的或与本合同有关的任何争议，双方应首先友好协商解决；协商不成的，任何一方均可向甲方所在地有管辖权的人民法院提起诉讼。"
    )
    d.p("17.2  争议解决期间，除争议事项外，双方应继续履行本合同其他条款。")

    # p20 第十八条
    d.h1("第十八条  其他约定", new_page=True)
    d.p(
        "18.1  本合同自双方授权代表签字并加盖公章之日起生效，一式肆份，双方各执贰份，具有同等法律效力。"
    )
    d.p(
        "18.2  本合同附件与正文具有同等法律效力。附件包括：附件一《服务清单》、附件二《验收标准》、附件三《数据处理与安全要求》。"
    )
    d.p("18.3  本合同取代双方此前就同一事项达成的一切口头或书面意向、报价与备忘录。")
    d.p("18.4  通知送达地址以合同首部所列地址为准，一方变更地址的应提前书面通知。")

    # p21-26 附件一 服务清单（长表，用于制造体量）
    d.h1("附件一  服务清单", new_page=True)
    d.p("本附件列明乙方应交付的服务项、工作量与交付物。工作量以人天计，单价已包含在合同总价中。")
    items = [
        ("MES 核心模块部署", "现场部署、参数配置、主数据初始化", "25", "部署手册、配置基线"),
        ("组织与权限建模", "按甲方组织架构配置角色、权限与审批流", "12", "权限矩阵、配置说明"),
        ("物料主数据迁移", "清洗、去重、映射、导入与核对", "18", "迁移脚本、核对报告"),
        ("工艺路线建模", "按产品族建立工艺路线与工序标准", "20", "工艺路线清单"),
        ("ERP-MES 接口开发", "生产订单、库存、成本三类接口", "30", "接口文档、联调记录"),
        ("质量检验模块", "检验计划、抽样规则、判定逻辑", "15", "检验配置、测试用例"),
        ("仓储看板", "库位、批次、先进先出可视化", "10", "看板配置、使用说明"),
        ("报表与驾驶舱", "十二张管理报表与一张综合驾驶舱", "22", "报表清单、取数说明"),
        ("用户培训", "三个部门共六场培训，含考核", "8", "培训材料、考核记录"),
        ("上线支持", "上线首月驻场支持", "20", "值班记录、问题清单"),
    ]
    for i, (name, desc, days, deliver) in enumerate(items, 1):
        d.need(4 * LINE_H)
        d.p(f"1.{i}  {name}（工作量 {days} 人天）")
        d.p(f"服务内容：{desc}", indent=14)
        d.p(f"交付物：{deliver}", indent=14)
        if i % 3 == 0:
            d.new_page()

    # p27-32 附件二 验收标准
    d.h1("附件二  验收标准", new_page=True)
    d.p("本附件所列指标为终验的通过条件，任一项未达标即视为终验不通过。")
    stds = [
        ("接口成功率", "ERP-MES 接口连续七十二小时成功率不低于 99.5%"),
        ("订单同步时延", "生产订单从 ERP 下达至 MES 可见的时延不超过 60 秒（P95）"),
        ("数据一致性", "物料主数据抽样一千条，字段一致率不低于 99.9%"),
        ("并发能力", "支持 200 个并发终端在线操作，响应时间不超过 3 秒"),
        ("报表准确性", "十二张报表与源系统对账，金额差异为零"),
        ("可用性", "上线后三十日内系统可用率不低于 99.5%"),
        ("安全", "通过甲方信息安全部门的口令、权限、日志三项检查"),
        ("文档完整性", "交付文档齐全，且与系统实际配置一致"),
    ]
    for i, (k, v) in enumerate(stds, 1):
        d.need(3 * LINE_H)
        d.p(f"2.{i}  {k}")
        d.p(f"标准：{v}", indent=14)
        d.p("验证方式：由甲方质量管理部组织，乙方配合提供测试环境与数据。", indent=14)

    # p33-39 附件三 数据处理与安全要求
    d.h1("附件三  数据处理与安全要求", new_page=True)
    d.p(
        "本附件适用于乙方在履行本合同过程中对甲方数据的访问、传输、存储与销毁。乙方应指定数据安全责任人，并在人员入场前完成背景核查与保密承诺签署。"
    )
    for i in range(1, 15):
        d.need(3 * LINE_H)
        d.p(f"3.{i}  数据分级与访问控制")
        d.p(
            "甲方数据分为公开、内部、秘密三级。乙方人员仅可访问为履行本合同所必需的最小范围数据，访问应经甲方数据责任人书面授权，授权期限不超过九十日，到期自动失效。",
            indent=14,
        )
        if i % 4 == 0:
            d.new_page()

    # p40 签署页
    d.h1("签署页", new_page=True)
    d.p("（本页无正文，为《技术服务合同》之签署页）")
    d.y += 20
    d.p("甲方：浙江海临智能装备有限公司（盖章）")
    d.p("授权代表：____________________")
    d.p("日期：2024 年 3 月 18 日")
    d.y += 30
    d.p("乙方：宁波承远信息技术服务有限公司（盖章）")
    d.p("授权代表：____________________")
    d.p("日期：2024 年 3 月 18 日")

    return d.save("合同A_主合同.pdf")


# ---------------------------------------------------------------------------
# 合同 B：补充协议（6 页，改 12.1 的付款期限）
# ---------------------------------------------------------------------------
def build_contract_b() -> Path:
    d = Doc("技术服务合同补充协议（一）   合同编号：HT-2024-0871-BC1", "HT-2024-0871-BC1")
    y = 200
    d.page.insert_text((MARGIN_L + 70, y), "技术服务合同补充协议（一）", fontname="F0", fontsize=20)
    for i, t in enumerate(
        [
            "主合同编号：HT-2024-0871",
            "甲方：浙江海临智能装备有限公司",
            "乙方：宁波承远信息技术服务有限公司",
            "签订日期：2024 年 6 月 5 日",
        ]
    ):
        d.page.insert_text((MARGIN_L + 40, y + 70 + i * 24), t, fontname="F0", fontsize=12)
    d.new_page()

    d.h1("一、变更事由")
    d.p(
        "鉴于甲方内部财务结算周期调整，双方经协商一致，就主合同第十二条《付款条款》项下的付款期限及相关单据要求作出如下变更。本补充协议为主合同不可分割的组成部分。"
    )
    d.h1("二、具体变更")
    d.p(
        "2.1  原 12.1 条约定“收到发票及验收单据后三十（30）日内”支付，现变更为“收到发票及验收单据后六十（60）日内”支付。"
    )
    d.p(
        "2.2  原 12.3 条约定逾期违约金按日万分之五计算，现变更为按日万分之三计算，逾期超过六十日的暂停服务权保留。"
    )
    d.p("2.3  新增 12.10 条：甲方以银行承兑汇票支付的，票据期限不超过六个月，贴现费用由甲方承担。")
    d.p("2.4  除上述变更外，主合同其余条款继续有效。")
    d.h1("三、生效")
    d.p("本补充协议自双方授权代表签字并加盖公章之日起生效，与主合同具有同等法律效力。")
    return d.save("合同B_补充协议.pdf")


def build_docx() -> Path:
    from docx import Document
    from docx.shared import Pt

    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(10.5)

    doc.add_heading("付款条款内部说明（财务部）", level=1)
    doc.add_paragraph("本文档为内部说明，不对外，用于解释主合同第十二条在实际结算中的操作口径。")
    doc.add_heading("一、口径说明", level=2)
    for t in [
        "1. 付款期限起算点：以财务系统收到合规发票的登记日为准，不以业务部门签收日为准。",
        "2. 单据不齐备的，以补正材料到齐之日重新起算，需在系统中留痕。",
        "3. 逾期违约金的计算基数为逾期未付金额，不含已开票未到期的部分。",
    ]:
        doc.add_paragraph(t)
    doc.add_heading("二、与主合同的差异提醒", level=2)
    doc.add_paragraph(
        "补充协议（一）已将付款期限由三十日变更为六十日，结算系统参数需同步调整；如仍按三十日执行，将产生不必要的违约金支出。"
    )
    doc.add_paragraph("三、审批流程：单笔超过五十万元的付款，需经财务负责人与分管副总双签。")
    path = OUT / "付款条款_内部说明.docx"
    doc.save(path)
    return path


if __name__ == "__main__":
    a = build_contract_a()
    b = build_contract_b()
    c = build_docx()
    for p in (a, b, c):
        print(f"{p.name:32s} {p.stat().st_size:>9,} bytes")
