# Vibe Coding 培训幻灯片

34 页、90 分钟、16:9，面向技术混合受众。课程采用全部静态回放，不要求学员跟做。

## 生成

```bash
python3 -m venv /tmp/vibe-slides-venv
/tmp/vibe-slides-venv/bin/pip install -r requirements.txt
/tmp/vibe-slides-venv/bin/python generate_slides.py
```

建议将虚拟环境放在项目目录外。Windows 请使用等价的临时目录与虚拟环境命令。

如需同时生成逐页 PNG 与 contact sheet：

```bash
VIBE_SLIDES_PREVIEW_DIR=/tmp/vibe-slides-preview \
  /tmp/vibe-slides-venv/bin/python generate_slides.py
```

脚本从同一内容与布局模型生成：

- `vibe-coding-training.pptx`：文字和几何图形可编辑；
- `vibe-coding-training.pdf`：内容一致的固定渲染播放兜底。

## 设计系统

新版采用“编辑式演讲稿 / 工作材料册”语言：暖白纸面、墨黑正文、历史输出摘要的静态重构材料、规范摘录、审阅批注与证据账本。版式使用 1600×900 的 12 列网格（左右 96、列宽 88、沟槽 32）和 8px 垂直基线。绿色只表示已验证，红色只表示失败或人工确认，黄色只表示提问与注意。

## 字体

- PPTX 中文字体设置为 `Microsoft YaHei`，英文和数字为 `Aptos`，代码为 `Aptos Mono`。字体不嵌入；缺失时 PowerPoint 会使用系统替代字体，播放前应复查换行与基线。
- PDF 和 PNG 默认寻找 PingFang、思源黑体或 Noto CJK。可通过 `VIBE_SLIDES_CJK_FONT` 指定 `.ttf`、`.otf` 或 `.ttc`。
- TTC 字体索引可由 `VIBE_SLIDES_CJK_REGULAR_INDEX`、`VIBE_SLIDES_CJK_MEDIUM_INDEX`、`VIBE_SLIDES_CJK_BOLD_INDEX` 覆盖。

## PDF 限制

Pillow 使用指定中文字体固定渲染每页，ReportLab 将页面封装为 PDF，因此 PDF 不依赖 PowerPoint 或 LibreOffice。PDF 页面为高分辨率整页图，不提供可选择文本；需要编辑时使用 PPTX。
