#!/usr/bin/env python3
"""Generate the Vibe Coding training deck from one editable layout model.

The model uses a 1600×900 design coordinate system. PPTX, PDF and optional PNG
previews are separate renderers over the same list of text and geometric
elements. No external images or brand assets are used.
"""

from __future__ import annotations

import math
import os
from io import BytesIO
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, cast

from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_LINE_DASH_STYLE
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


W, H = 1600, 900
PPT_W, PPT_H = 13.333333, 7.5

# Deep-water control room: quiet navy surfaces, cyan signal, lime proof.
BG = "07111F"
BG_ALT = "091625"
SURFACE = "102237"
SURFACE_2 = "142B43"
GRID = "17314B"
WHITE = "F1F8FF"
MUTED = "8EA6BA"
CYAN = "38D6FF"
BLUE = "4A88FF"
LIME = "C7F36B"
YELLOW = "F4C95D"
RED = "FF6D7A"

CHAPTERS = {
    1: "开场",
    2: "概念",
    3: "概念",
    4: "闭环",
    5: "安全",
    6: "工具",
    7: "工具",
    8: "方法",
    9: "演示",
    10: "澄清",
    11: "规范",
    12: "RED",
    13: "纠偏",
    14: "GREEN",
    15: "质量",
    16: "证据",
    17: "落地",
    18: "收尾",
}


@dataclass
class Element:
    kind: str
    x: float
    y: float
    w: float
    h: float
    props: dict[str, Any] = field(default_factory=dict)


@dataclass
class SlideModel:
    number: int
    title: str
    elements: list[Element] = field(default_factory=list)

    def add(self, kind: str, x: float, y: float, w: float, h: float, **props: Any) -> Element:
        e = Element(kind, x, y, w, h, props)
        self.elements.append(e)
        return e


def rect(s: SlideModel, x: float, y: float, w: float, h: float, fill: str, radius: float = 0,
         stroke: str | None = None, stroke_w: float = 1) -> None:
    s.add("rect", x, y, w, h, fill=fill, radius=radius, stroke=stroke, stroke_w=stroke_w)


def line(s: SlideModel, x1: float, y1: float, x2: float, y2: float, color: str = GRID,
         width: float = 2, dash: bool = False, arrow: bool = False) -> None:
    s.add("line", x1, y1, x2 - x1, y2 - y1, color=color, width=width, dash=dash, arrow=arrow)


def circle(s: SlideModel, cx: float, cy: float, d: float, fill: str | None = None,
           stroke: str | None = None, stroke_w: float = 2) -> None:
    s.add("ellipse", cx - d / 2, cy - d / 2, d, d, fill=fill, stroke=stroke, stroke_w=stroke_w)


def txt(s: SlideModel, x: float, y: float, w: float, h: float, text: str, size: float,
        color: str = WHITE, weight: str = "regular", align: str = "left",
        valign: str = "top", font: str = "cjk", linespacing: float = 1.12) -> None:
    s.add("text", x, y, w, h, text=text, size=size, color=color, weight=weight,
          align=align, valign=valign, font=font, linespacing=linespacing)


def pill(s: SlideModel, x: float, y: float, w: float, text: str, color: str = CYAN,
         fill: str = SURFACE_2) -> None:
    rect(s, x, y, w, 42, fill, 21, color, 1.2)
    txt(s, x, y + 1, w, 40, text, 18, color, "medium", "center", "middle")


def card(s: SlideModel, x: float, y: float, w: float, h: float, title: str,
         body: str = "", accent: str = CYAN, number: str | None = None) -> None:
    rect(s, x, y, w, h, SURFACE, 22, GRID, 1.5)
    rect(s, x, y, 7, h, accent, 4)
    if number:
        txt(s, x + 28, y + 22, 65, 40, number, 25, accent, "bold", font="latin")
        tx = x + 98
    else:
        tx = x + 30
    txt(s, tx, y + 22, w - (tx - x) - 24, 44, title, 25, WHITE, "bold", valign="middle")
    if body:
        txt(s, x + 30, y + 78, w - 58, h - 88, body, 18, MUTED, "regular", linespacing=1.2)


def base_slide(number: int, title: str, kicker: str = "") -> SlideModel:
    s = SlideModel(number, title)
    rect(s, 0, 0, W, H, BG)
    # A restrained instrument-grid motif: context, not decoration.
    for gx in range(1120, 1601, 80):
        line(s, gx, 0, gx, 210, GRID, 1)
    for gy in range(30, 211, 60):
        line(s, 1120, gy, 1600, gy, GRID, 1)
    line(s, 84, 78, 126, 78, CYAN, 5)
    if kicker:
        txt(s, 145, 55, 720, 34, kicker.upper(), 17, CYAN, "medium", font="latin")
    if title:
        txt(s, 82, 105, 1160, 92, title, 48, WHITE, "bold")
    return s


def footer(s: SlideModel) -> None:
    y = 847
    line(s, 82, y, 1518, y, GRID, 1)
    # Evidence pulse: a recurring signal that resolves into a proof dot.
    line(s, 82, y, 122, y, CYAN, 2)
    line(s, 122, y, 132, y - 9, CYAN, 2)
    line(s, 132, y - 9, 142, y + 7, CYAN, 2)
    line(s, 142, y + 7, 153, y, CYAN, 2)
    line(s, 153, y, 180, y, CYAN, 2)
    circle(s, 190, y, 9, LIME)
    txt(s, 210, 852, 260, 25, CHAPTERS[s.number], 14, MUTED, "medium")
    txt(s, 1440, 852, 78, 25, f"{s.number:02d} / 18", 14, MUTED, "medium", "right", font="latin")


def node(s: SlideModel, cx: float, cy: float, d: float, label: str, color: str = CYAN,
         sub: str = "") -> None:
    circle(s, cx, cy, d, SURFACE, color, 3)
    txt(s, cx - d / 2 + 10, cy - 34, d - 20, 64, label, 20, WHITE, "bold", "center", "middle")
    if sub:
        txt(s, cx - 100, cy + d / 2 + 16, 200, 28, sub, 16, MUTED, "regular", "center")


def build_slides() -> list[SlideModel]:
    slides: list[SlideModel] = []

    # 01 — cover
    s = base_slide(1, "", "INTERNAL SHARE · 60 MIN")
    txt(s, 82, 174, 850, 130, "Vibe Coding", 82, WHITE, "bold", font="latin")
    txt(s, 88, 322, 720, 70, "从需求到证据的受控开发闭环", 32, CYAN, "medium")
    line(s, 88, 430, 730, 430, GRID, 2)
    pill(s, 88, 466, 210, "60 分钟内部分享", LIME)
    txt(s, 88, 542, 570, 62, "人握方向盘，证据定结论", 24, MUTED)
    # Open loop becoming a verified proof point.
    cx, cy, r = 1240, 420, 220
    for i in range(6):
        a1 = math.radians(205 + i * 49)
        a2 = math.radians(235 + i * 49)
        line(s, cx + r * math.cos(a1), cy + r * math.sin(a1),
             cx + r * math.cos(a2), cy + r * math.sin(a2), CYAN if i < 4 else BLUE, 8)
    circle(s, 1395, 575, 42, LIME)
    txt(s, 1368, 547, 54, 52, "✓", 32, BG, "bold", "center", "middle")
    footer(s); slides.append(s)

    # 02 — term correction
    s = base_slide(2, "先纠偏，再谈效率", "02 · TERM RESET")
    txt(s, 84, 245, 360, 120, "不是", 70, RED, "bold")
    rect(s, 82, 380, 580, 170, SURFACE, 22, RED, 2)
    txt(s, 118, 410, 510, 55, "“凭感觉接受输出”", 31, WHITE, "bold")
    txt(s, 118, 485, 470, 36, "输出 ≠ 结论", 21, MUTED)
    line(s, 700, 465, 880, 465, CYAN, 4, arrow=True)
    txt(s, 935, 245, 480, 120, "而是", 70, CYAN, "bold")
    rect(s, 930, 380, 500, 170, SURFACE, 22, CYAN, 2)
    txt(s, 966, 410, 430, 55, "受控 AI 辅助开发", 31, WHITE, "bold")
    txt(s, 966, 485, 420, 36, "证据 → 决策", 21, LIME, "medium")
    footer(s); slides.append(s)

    # 03 — human and AI
    s = base_slide(3, "人定方向，AI 提速", "03 · CONTROL SPLIT")
    rect(s, 82, 240, 650, 480, SURFACE, 28, CYAN, 2)
    txt(s, 122, 275, 530, 45, "HUMAN / 人", 22, CYAN, "bold", font="latin")
    txt(s, 122, 346, 520, 72, "掌舵", 52, WHITE, "bold")
    for i, t in enumerate(["目标", "约束", "决策", "证据"]):
        pill(s, 122 + (i % 2) * 250, 464 + (i // 2) * 78, 210, t, CYAN, BG_ALT)
    rect(s, 790, 240, 728, 480, SURFACE, 28, BLUE, 2)
    txt(s, 830, 275, 600, 45, "AI / 辅助", 22, BLUE, "bold", font="latin")
    txt(s, 830, 346, 530, 72, "副驾驶", 52, WHITE, "bold")
    card(s, 830, 466, 300, 150, "分析", "找路径、列影响", BLUE)
    card(s, 1160, 466, 300, 150, "实现", "按边界完成改动", BLUE)
    footer(s); slides.append(s)

    # 04 — loop
    s = base_slide(4, "开发不是直线，是闭环", "04 · CONTROL LOOP")
    points = [(220, 445), (500, 300), (830, 300), (1135, 445), (830, 625), (500, 625)]
    labels = [("需求澄清", "问清边界"), ("规范", "写下约定"), ("TDD RED", "先见失败"),
              ("TDD GREEN", "满足证据"), ("代码评审", "实现质量"), ("规范核对", "行为证据")]
    for i, (p1, p2) in enumerate(zip(points, points[1:] + points[:1])):
        line(s, p1[0], p1[1], p2[0], p2[1], CYAN if i < 4 else BLUE, 3, arrow=True)
    for (cx, cy), (label, sub) in zip(points, labels):
        node(s, cx, cy, 142, label, LIME if label == "规范核对" else CYAN, sub)
    line(s, 1170, 650, 1380, 650, RED, 3, dash=True, arrow=True)
    line(s, 1380, 650, 1380, 300, RED, 3, dash=True)
    line(s, 1380, 300, 1215, 300, RED, 3, dash=True, arrow=True)
    pill(s, 1220, 456, 230, "发现偏差 → 回环", RED, BG_ALT)
    footer(s); slides.append(s)

    # 05 — safety
    s = base_slide(5, "60 秒安全红线", "05 · STOP LINE")
    txt(s, 84, 230, 430, 190, "60", 154, CYAN, "bold", font="latin")
    txt(s, 338, 320, 170, 50, "秒", 34, MUTED, "bold")
    cards = [("敏感信息", "不上传"), ("密钥", "不展示"), ("生产权限", "AI 没有"), ("高风险动作", "人工确认")]
    for i, (a, b) in enumerate(cards):
        x = 590 + (i % 2) * 430
        y = 238 + (i // 2) * 205
        rect(s, x, y, 390, 164, SURFACE, 20, RED if i == 3 else GRID, 2)
        txt(s, x + 28, y + 26, 330, 38, a, 24, MUTED, "medium")
        txt(s, x + 28, y + 82, 330, 48, b, 34, WHITE if i < 3 else RED, "bold")
    txt(s, 84, 565, 420, 80, "不确定，就停下确认。", 30, WHITE, "bold")
    footer(s); slides.append(s)

    # 06 — tool role map
    s = base_slide(6, "按职责理解工具，不背品牌", "06 · ROLE MAP")
    node(s, 800, 485, 210, "受控开发", LIME, "目标与证据居中")
    role_nodes = [
        (250, 300, "AI Coding\nAgent", "辅助分析 / 实现"),
        (540, 670, "编排扩展", "组织协作"),
        (1060, 670, "OpenSpec", "规范 / 核对"),
        (1350, 300, "skills", "能力扩展模式"),
        (800, 235, "MCP", "上下文协议"),
    ]
    for cx, cy, label, sub in role_nodes:
        line(s, 800, 485, cx, cy, GRID, 2)
        node(s, cx, cy, 156, label, CYAN if label != "OpenSpec" else BLUE, sub)
    pill(s, 1175, 520, 280, "skills 无统一标准", YELLOW, BG_ALT)
    footer(s); slides.append(s)

    # 07 — project facts
    s = base_slide(7, "讲师工具链 ≠ 项目现状", "07 · REALITY CHECK")
    facts = [
        ("项目已有", "opsx-* 命令", "AVAILABLE", LIME),
        ("当前为空", "skills-lock", "EMPTY", YELLOW),
        ("仓库未配", "MCP", "NOT CONFIGURED", MUTED),
    ]
    for i, (eyebrow, label, status, color) in enumerate(facts):
        x = 84 + i * 500
        rect(s, x, 275, 450, 330, SURFACE, 24, GRID, 1.5)
        txt(s, x + 30, 310, 380, 34, eyebrow, 18, color, "medium")
        txt(s, x + 30, 374, 380, 65, label, 38, WHITE, "bold", font="latin" if i > 0 else "cjk")
        line(s, x + 30, 470, x + 420, 470, GRID, 1)
        circle(s, x + 44, 535, 14, color)
        txt(s, x + 66, 516, 340, 40, status, 17, color, "bold", font="latin")
    pill(s, 496, 655, 610, "先看仓库事实，再谈可选扩展", CYAN, BG_ALT)
    footer(s); slides.append(s)

    # 08 — risk adaptation
    s = base_slide(8, "风险变，控制意图不变", "08 · RISK ADAPTATION")
    levels = [("低", 225, 470, 220, CYAN, "聚焦证据"), ("中", 690, 390, 300, BLUE, "扩大检查"),
              ("高", 1200, 300, 390, RED, "人工确认 + 深证据")]
    for label, cx, cy, d, color, sub in levels:
        circle(s, cx, cy, d, SURFACE, color, 4)
        txt(s, cx - d/2, cy - 58, d, 78, label, 56, WHITE, "bold", "center", "middle")
        txt(s, cx - d/2, cy + 32, d, 40, sub, 17, color, "medium", "center")
    line(s, 150, 730, 1450, 730, LIME, 5)
    for x, label in [(265, "目标"), (665, "边界"), (1065, "验证证据")]:
        circle(s, x, 730, 20, LIME)
        txt(s, x + 22, 710, 210, 40, label, 21, WHITE, "bold")
    footer(s); slides.append(s)

    # 09 — demo requirement
    s = base_slide(9, "演示需求：配置临期窗口", "09 · DEMO BRIEF")
    rect(s, 84, 235, 700, 510, SURFACE, 26, GRID, 1.5)
    txt(s, 126, 270, 580, 34, "提醒面板 / 临期窗口", 18, MUTED, "medium")
    txt(s, 126, 342, 370, 55, "临期窗口", 30, WHITE, "bold")
    rect(s, 126, 420, 300, 86, BG, 16, CYAN, 2)
    txt(s, 151, 430, 230, 62, "0", 44, WHITE, "bold", font="latin", valign="middle")
    txt(s, 446, 445, 88, 40, "天", 22, MUTED, "medium")
    rect(s, 548, 420, 184, 86, CYAN, 16)
    txt(s, 548, 429, 184, 60, "保存", 25, BG, "bold", "center", "middle")
    line(s, 126, 558, 732, 558, GRID, 1)
    txt(s, 126, 590, 280, 38, "提醒日期", 19, MUTED)
    txt(s, 430, 590, 302, 38, "2026-08-11", 21, WHITE, "medium", "right", font="latin")
    requirements = [("0 有语义", LIME), ("非负安全整数", CYAN), ("显式保存 / 刷新", CYAN),
                    ("持久化", BLUE), ("日期可见", BLUE)]
    for i, (label, color) in enumerate(requirements):
        y = 250 + i * 92
        circle(s, 900, y + 22, 20, color)
        txt(s, 928, y, 500, 46, label, 27, WHITE, "bold", valign="middle")
    footer(s); slides.append(s)

    # 10 — grill vote
    s = base_slide(10, "先问对，才做对", "10 · GRILL / VOTE")
    txt(s, 625, 195, 350, 260, "?", 210, CYAN, "bold", "center", "middle", font="latin")
    questions = ["0 天是什么？", "需要业务上限吗？", "要不要 reset？"]
    for i, q in enumerate(questions):
        x = 82 + i * 500
        rect(s, x, 520, 450, 170, SURFACE, 22, CYAN if i < 2 else YELLOW, 2)
        txt(s, x + 25, 542, 400, 105, q, 29, WHITE, "bold", "center", "middle")
    pill(s, 620, 730, 360, "举手投票 · 先不揭答案", LIME, BG_ALT)
    footer(s); slides.append(s)

    # 11 — openspec
    s = base_slide(11, "同一 change，规则逐步变清", "11 · OPENSPEC")
    line(s, 220, 460, 1380, 460, GRID, 5)
    stages = [
        (260, "原始 propose", "基础规则", CYAN),
        (650, "Grill", "发现边界", YELLOW),
        (1040, "更新 spec", "同一 change", BLUE),
        (1380, "验收场景", "可验证", LIME),
    ]
    for x, label, sub, color in stages:
        circle(s, x, 460, 34, color)
        txt(s, x - 130, 330, 260, 48, label, 26, WHITE, "bold", "center")
        txt(s, x - 120, 506, 240, 34, sub, 18, color, "medium", "center")
    pill(s, 440, 620, 720, "不新建重叠 change · spec 写约定，不写步骤", CYAN, BG_ALT)
    footer(s); slides.append(s)

    # 12 — red
    s = base_slide(12, "RED：失败先成为证据", "12 · TDD RED")
    pill(s, 84, 224, 270, "baseline  76747c1", MUTED, BG_ALT)
    line(s, 370, 245, 520, 245, RED, 3, arrow=True)
    pill(s, 540, 224, 280, "red-test  f771667", RED, BG_ALT)
    card(s, 84, 355, 690, 250, "MAIN", "2 项失败\nV2_MUTATION_UNKNOWN", RED, "02")
    card(s, 826, 355, 690, 250, "UI", "1 项失败\n“临期窗口”控件缺失", RED, "01")
    txt(s, 84, 673, 1432, 60, "红，不是故障；它证明行为尚未实现。", 30, WHITE, "bold", "center")
    footer(s); slides.append(s)

    # 13 — preset failure
    s = base_slide(13, "能运行 ≠ 做正确", "13 · PRESET FAILURE · 0554164")
    stages = [("IPC", LIME), ("facade", LIME), ("UI", LIME), ("规则", RED)]
    for i, (label, color) in enumerate(stages):
        cx = 230 + i * 370
        if i:
            line(s, cx - 280, 380, cx - 85, 380, LIME if i < 3 else RED, 4, arrow=True)
        node(s, cx, 380, 150, label, color)
        txt(s, cx - 80, 487, 160, 32, "已接通" if i < 3 else "拒绝 0", 18, color, "medium", "center")
    rect(s, 460, 595, 680, 96, BG_ALT, 18, RED, 2)
    txt(s, 492, 610, 616, 55, "错误约束：临期窗口 >= 1", 29, RED, "bold", "center", "middle", font="latin")
    footer(s); slides.append(s)

    # 14 — green
    s = base_slide(14, "GREEN：边界、界面、数据对齐", "14 · GREEN · d304bd5")
    circle(s, 395, 480, 340, BG_ALT, LIME, 10)
    txt(s, 235, 333, 320, 270, "0", 198, WHITE, "bold", "center", "middle", font="latin")
    txt(s, 225, 650, 340, 40, "合法值", 25, LIME, "bold", "center")
    checks = [("安全整数", "0..9007199254740991"), ("立即刷新", "保存后重分类"), ("持久化", "重开仍保留")]
    for i, (title, body) in enumerate(checks):
        y = 270 + i * 155
        circle(s, 760, y + 38, 42, LIME)
        txt(s, 742, y + 13, 36, 45, "✓", 26, BG, "bold", "center", "middle")
        txt(s, 810, y, 560, 46, title, 30, WHITE, "bold")
        txt(s, 810, y + 54, 570, 38, body, 19, MUTED, "medium", font="latin" if i == 0 else "cjk")
    footer(s); slides.append(s)

    # 15 — double gates
    s = base_slide(15, "质量双门：互补，不替代", "15 · TWO GATES")
    rect(s, 84, 270, 650, 390, SURFACE, 26, CYAN, 2)
    txt(s, 126, 306, 530, 36, "GATE 01", 18, CYAN, "bold", font="latin")
    txt(s, 126, 374, 520, 58, "Code Review", 39, WHITE, "bold", font="latin")
    txt(s, 126, 470, 500, 42, "安全 · 清晰 · 可维护", 25, MUTED, "medium")
    rect(s, 866, 270, 650, 390, SURFACE, 26, LIME, 2)
    txt(s, 908, 306, 530, 36, "GATE 02", 18, LIME, "bold", font="latin")
    txt(s, 908, 374, 540, 58, "OpenSpec Verification", 34, WHITE, "bold", font="latin")
    txt(s, 908, 470, 500, 42, "约定行为 · 验收证据", 25, MUTED, "medium")
    line(s, 734, 465, 866, 465, BLUE, 5)
    circle(s, 800, 465, 24, BLUE)
    pill(s, 584, 710, 432, "两道都过，才关闭闭环", CYAN, BG_ALT)
    footer(s); slides.append(s)

    # 16 — evidence list
    s = base_slide(16, "证据清单：从聚焦到系统", "16 · EVIDENCE STACK")
    evidence = [
        ("95", "聚焦测试", LIME),
        ("1076", "全量测试", LIME),
        ("STRICT", "规格结构", CYAN),
        ("BUILD", "Electron", BLUE),
        ("1 / 1", "布局 E2E", LIME),
    ]
    for i, (value, label, color) in enumerate(evidence):
        x = 84 + i * 294
        h = 260 + i * 24
        y = 650 - h
        rect(s, x, y, 250, h, SURFACE, 22, color, 2)
        txt(s, x + 18, y + 36, 214, 72, value, 43 if len(value) < 6 else 27, WHITE, "bold", "center", "middle", font="latin")
        txt(s, x + 18, y + h - 66, 214, 38, label, 20, color, "medium", "center")
    rect(s, 84, 712, 1432, 60, BG_ALT, 12, YELLOW, 1.5)
    txt(s, 110, 724, 1380, 34, "macOS arm64 构建通过 ≠ Windows 平台验证", 22, YELLOW, "bold", "center")
    footer(s); slides.append(s)

    # 17 — everyday practice
    s = base_slide(17, "把闭环变成日常动作", "17 · DAILY PATH")
    steps = ["读上下文", "定目标 / 边界", "按风险选流程", "限制写入", "看 diff", "聚焦证据", "质量双门"]
    coords = [(155, 300), (475, 300), (795, 300), (1115, 300), (1115, 610), (795, 610), (475, 610)]
    for i, ((x, y), label) in enumerate(zip(coords, steps)):
        if i:
            px, py = coords[i - 1]
            line(s, px + 116, py + 62, x + 5, y + 62, CYAN if i < 4 else BLUE, 3, arrow=True)
        rect(s, x, y, 250, 124, SURFACE, 20, LIME if i == 6 else GRID, 1.5)
        txt(s, x + 18, y + 18, 42, 34, f"{i+1:02d}", 18, CYAN, "bold", font="latin")
        txt(s, x + 18, y + 56, 214, 42, label, 23, WHITE, "bold", "center", "middle")
    pill(s, 1000, 770, 460, "小步、可见、可回环", LIME, BG_ALT)
    footer(s); slides.append(s)

    # 18 — close
    s = base_slide(18, "", "18 · Q&A")
    txt(s, 82, 172, 800, 82, "Q&A", 62, CYAN, "bold", font="latin")
    txt(s, 82, 320, 1436, 115, "受控 · 证据 · 闭环", 70, WHITE, "bold", "center", "middle")
    line(s, 340, 490, 1260, 490, GRID, 2)
    txt(s, 260, 560, 1080, 74, "让 AI 加速开发，让证据决定完成。", 30, MUTED, "medium", "center", "middle")
    circle(s, 800, 718, 24, LIME)
    footer(s); slides.append(s)

    return slides


def _hex(value: str) -> tuple[int, int, int]:
    return cast(tuple[int, int, int], tuple(int(value[i:i + 2], 16) for i in (0, 2, 4)))


def _font_candidates() -> list[str]:
    env = os.environ.get("VIBE_SLIDES_CJK_FONT")
    return [p for p in [
        env,
        "/System/Library/AssetsV2/com_apple_MobileAsset_Font8/86ba2c91f017a3749571a82f2c6d890ac7ffb2fb.asset/AssetData/PingFang.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
        str(Path.home() / "Library/Fonts/SourceHanSansSC-Regular.otf"),
    ] if p]


def resolve_font() -> Path:
    for candidate in _font_candidates():
        path = Path(candidate).expanduser()
        if path.is_file():
            return path
    raise FileNotFoundError(
        "No CJK font found. Set VIBE_SLIDES_CJK_FONT to a Chinese .ttf/.otf/.ttc file."
    )


def font_indexes(path: Path) -> dict[str, int]:
    if path.suffix.lower() != ".ttc":
        return {"regular": 0, "medium": 0, "bold": 0}
    # Verified PingFang SC faces; override for other TTC collections.
    return {
        "regular": int(os.environ.get("VIBE_SLIDES_CJK_REGULAR_INDEX", "3")),
        "medium": int(os.environ.get("VIBE_SLIDES_CJK_MEDIUM_INDEX", "7")),
        "bold": int(os.environ.get("VIBE_SLIDES_CJK_BOLD_INDEX", "11")),
    }


def render_pptx(slides: Iterable[SlideModel], output: Path) -> None:
    models = list(slides)
    prs = Presentation()
    prs.slide_width = Inches(PPT_W)
    prs.slide_height = Inches(PPT_H)
    blank = prs.slide_layouts[6]
    sx, sy = PPT_W / W, PPT_H / H
    for model in models:
        slide = prs.slides.add_slide(blank)
        for e in model.elements:
            p = e.props
            x, y, w, h = Inches(e.x * sx), Inches(e.y * sy), Inches(e.w * sx), Inches(e.h * sy)
            if e.kind in ("rect", "ellipse"):
                shape_type = MSO_SHAPE.OVAL if e.kind == "ellipse" else (
                    MSO_SHAPE.ROUNDED_RECTANGLE if p.get("radius", 0) else MSO_SHAPE.RECTANGLE)
                shape = slide.shapes.add_shape(shape_type, x, y, w, h)
                if p.get("fill"):
                    shape.fill.solid(); shape.fill.fore_color.rgb = RGBColor(*_hex(p["fill"]))
                else:
                    shape.fill.background()
                if p.get("stroke"):
                    shape.line.color.rgb = RGBColor(*_hex(p["stroke"]))
                    shape.line.width = Pt(p.get("stroke_w", 1) * 0.7)
                else:
                    shape.line.fill.background()
                if e.kind == "rect" and p.get("radius", 0):
                    try:
                        shape.adjustments[0] = min(0.25, p["radius"] / max(1, min(e.w, e.h)))
                    except (IndexError, ValueError):
                        pass
            elif e.kind == "line":
                end_x, end_y = Inches((e.x + e.w) * sx), Inches((e.y + e.h) * sy)
                shape = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, x, y, end_x, end_y)
                shape.line.color.rgb = RGBColor(*_hex(p["color"]))
                shape.line.width = Pt(p.get("width", 2) * 0.7)
                if p.get("dash"):
                    shape.line.dash_style = MSO_LINE_DASH_STYLE.DASH
                if p.get("arrow"):
                    marker = slide.shapes.add_shape(
                        MSO_SHAPE.ISOSCELES_TRIANGLE,
                        Inches((e.x + e.w) * sx - 0.055),
                        Inches((e.y + e.h) * sy - 0.055),
                        Inches(0.11), Inches(0.11),
                    )
                    marker.fill.solid(); marker.fill.fore_color.rgb = RGBColor(*_hex(p["color"]))
                    marker.line.fill.background()
                    marker.rotation = math.degrees(math.atan2(e.h, e.w)) + 90
            elif e.kind == "text":
                box = slide.shapes.add_textbox(x, y, w, h)
                tf = box.text_frame
                tf.clear(); tf.word_wrap = True
                tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
                tf.vertical_anchor = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE,
                                      "bottom": MSO_ANCHOR.BOTTOM}[p.get("valign", "top")]
                lines = p["text"].split("\n")
                for i, text_line in enumerate(lines):
                    para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                    para.text = text_line
                    para.alignment = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER,
                                      "right": PP_ALIGN.RIGHT}[p.get("align", "left")]
                    para.space_after = Pt(0)
                    para.line_spacing = p.get("linespacing", 1.12)
                    run = para.runs[0]
                    run.font.size = Pt(p["size"] * 0.75)
                    run.font.bold = p.get("weight") == "bold"
                    run.font.color.rgb = RGBColor(*_hex(p["color"]))
                    family = "Aptos" if p.get("font") == "latin" else "Microsoft YaHei"
                    run.font.name = family
                    run._r.get_or_add_rPr().set(qn("a:ea"), "Microsoft YaHei")
                    run._r.get_or_add_rPr().set(qn("a:latin"), "Aptos")
    prs.save(output)


def render_pdf(slides: Iterable[SlideModel], output: Path, font_path: Path) -> None:
    pw, ph = 960, 540
    c = canvas.Canvas(str(output), pagesize=(pw, ph), pageCompression=1)
    for model in slides:
        # PingFang uses PostScript outlines that ReportLab cannot embed directly.
        # Pillow renders the verified CJK face; ReportLab packages each lossless
        # page. PPTX remains fully editable, while PDF remains deterministic.
        image = render_slide_image(model, font_path)
        buffer = BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        buffer.seek(0)
        c.drawImage(ImageReader(buffer), 0, 0, width=pw, height=ph, preserveAspectRatio=True, mask="auto")
        c.showPage()
    c.save()


def pillow_font(path: Path, size: int, weight: str) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), max(1, size), index=font_indexes(path)[weight])


def render_slide_image(model: SlideModel, font_path: Path, scale: float = 1.0) -> Image.Image:
    im = Image.new("RGB", (int(W * scale), int(H * scale)), _hex(BG))
    d = ImageDraw.Draw(im)
    for e in model.elements:
            p = e.props
            box = tuple(int(v * scale) for v in (e.x, e.y, e.x + e.w, e.y + e.h))
            if e.kind == "rect":
                d.rounded_rectangle(box, radius=int(p.get("radius", 0) * scale), fill=_hex(p["fill"]) if p.get("fill") else None,
                                    outline=_hex(p["stroke"]) if p.get("stroke") else None,
                                    width=max(1, int(p.get("stroke_w", 1) * scale)))
            elif e.kind == "ellipse":
                d.ellipse(box, fill=_hex(p["fill"]) if p.get("fill") else None,
                          outline=_hex(p["stroke"]) if p.get("stroke") else None,
                          width=max(1, int(p.get("stroke_w", 1) * scale)))
            elif e.kind == "line":
                xy = [(int(e.x * scale), int(e.y * scale)), (int((e.x + e.w) * scale), int((e.y + e.h) * scale))]
                if p.get("dash"):
                    _pillow_dashed_line(d, xy[0], xy[1], _hex(p["color"]), max(1, int(p.get("width", 2) * scale)))
                else:
                    d.line(xy, fill=_hex(p["color"]), width=max(1, int(p.get("width", 2) * scale)))
                if p.get("arrow"):
                    _pillow_arrow(d, xy[0], xy[1], _hex(p["color"]), int(14 * scale))
            elif e.kind == "text":
                font = pillow_font(font_path, int(p["size"] * scale), p.get("weight", "regular"))
                lines = p["text"].split("\n")
                spacing = int(p["size"] * (p.get("linespacing", 1.12) - 1) * scale)
                bbox = d.multiline_textbbox((0, 0), p["text"], font=font, spacing=spacing, align=p.get("align", "left"))
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                tx = e.x * scale if p.get("align") == "left" else ((e.x + e.w / 2) * scale - tw / 2 if p.get("align") == "center" else (e.x + e.w) * scale - tw)
                ty = e.y * scale if p.get("valign") == "top" else ((e.y + e.h / 2) * scale - th / 2 if p.get("valign") == "middle" else (e.y + e.h) * scale - th)
                d.multiline_text((tx, ty - bbox[1]), p["text"], font=font, fill=_hex(p["color"]), spacing=spacing,
                                 align=p.get("align", "left"))
    return im


def render_pngs(slides: Iterable[SlideModel], output_dir: Path, font_path: Path, scale: float = 1.0) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for model in slides:
        im = render_slide_image(model, font_path, scale)
        path = output_dir / f"slide-{model.number:02d}.png"
        im.save(path, optimize=True)
        paths.append(path)
    _contact_sheet(paths, output_dir / "contact-sheet.png")
    return paths


def _pillow_dashed_line(d: ImageDraw.ImageDraw, a: tuple[int, int], b: tuple[int, int], color: tuple[int, int, int], width: int) -> None:
    length = math.dist(a, b)
    if length == 0:
        return
    ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
    pos = 0.0
    while pos < length:
        end = min(length, pos + 12)
        d.line([(a[0] + ux * pos, a[1] + uy * pos), (a[0] + ux * end, a[1] + uy * end)], fill=color, width=width)
        pos += 20


def _pillow_arrow(d: ImageDraw.ImageDraw, a: tuple[int, int], b: tuple[int, int], color: tuple[int, int, int], size: int) -> None:
    angle = math.atan2(b[1] - a[1], b[0] - a[0])
    pts = [b, (b[0] - size * math.cos(angle - 0.5), b[1] - size * math.sin(angle - 0.5)),
           (b[0] - size * math.cos(angle + 0.5), b[1] - size * math.sin(angle + 0.5))]
    d.polygon(pts, fill=color)


def _contact_sheet(paths: list[Path], output: Path) -> None:
    thumb_w, thumb_h = 400, 225
    sheet = Image.new("RGB", (thumb_w * 3, thumb_h * 6), _hex(BG))
    for i, path in enumerate(paths):
        im = Image.open(path).convert("RGB"); im.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        sheet.paste(im, ((i % 3) * thumb_w, (i // 3) * thumb_h))
    sheet.save(output, optimize=True)


def validate_model(slides: list[SlideModel]) -> None:
    if len(slides) != 18:
        raise ValueError(f"Expected 18 slides, got {len(slides)}")
    for slide in slides:
        for e in slide.elements:
            if e.x < -1 or e.y < -1 or e.x + e.w > W + 1 or e.y + e.h > H + 1:
                raise ValueError(f"Slide {slide.number}: out-of-bounds {e}")


def main() -> None:
    root = Path(__file__).resolve().parent
    slides = build_slides()
    validate_model(slides)
    font_path = resolve_font()
    render_pptx(slides, root / "vibe-coding-training.pptx")
    render_pdf(slides, root / "vibe-coding-training.pdf", font_path)
    preview_env = os.environ.get("VIBE_SLIDES_PREVIEW_DIR")
    if preview_env:
        render_pngs(slides, Path(preview_env).expanduser(), font_path)
    print(f"Generated {len(slides)} slides")
    print(f"CJK render font: {font_path}")


if __name__ == "__main__":
    main()
