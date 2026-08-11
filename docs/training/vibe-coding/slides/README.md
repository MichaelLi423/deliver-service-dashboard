# Vibe Coding 培训幻灯片

## 生成

```bash
python3 -m venv /tmp/vibe-slides-venv
/tmp/vibe-slides-venv/bin/pip install -r requirements.txt
/tmp/vibe-slides-venv/bin/python generate_slides.py
```

建议将虚拟环境放在仓库外；Windows 可使用等价的临时目录与虚拟环境命令。

脚本从同一份内容与布局模型生成：

- `vibe-coding-training.pptx`：16:9、18 页，文字与几何图形可编辑；
- `vibe-coding-training.pdf`：18 页，内容一致的预览与播放兜底。

如需同时输出逐页 PNG 和 contact sheet：

```bash
VIBE_SLIDES_PREVIEW_DIR=/tmp/vibe-slides-preview python generate_slides.py
```

## 字体

- PPTX 中文字体标记为 `Microsoft YaHei`，英文、数字和代码标记为 `Aptos`。字体不嵌入；Windows 缺少微软雅黑时，PowerPoint 会按系统设置替代，建议优先替换为等宽度的中文无衬线字体（如等线或思源黑体），并复查换行。
- PDF 与 PNG 默认按顺序查找 PingFang、思源黑体/Noto CJK 等常见字体。可用 `VIBE_SLIDES_CJK_FONT` 指定 `.ttf`/`.otf`/`.ttc`；TTC 默认使用简体中文 Regular/Medium/Semibold 字形，可分别用 `VIBE_SLIDES_CJK_REGULAR_INDEX`、`VIBE_SLIDES_CJK_MEDIUM_INDEX`、`VIBE_SLIDES_CJK_BOLD_INDEX` 覆盖索引。
- 当前已验证的 macOS 字体路径会作为候选路径自动发现，但不是生成的唯一条件。若没有找到支持中文的字体，脚本会停止并提示设置环境变量，避免生成缺字文件。

## 输出说明

PDF 不依赖 PowerPoint 或 LibreOffice：Pillow 使用指定中文字体逐页渲染，ReportLab 将无损页面封装为 PDF，因此适合跨机器预览和播放兜底。PDF 页面是高分辨率整页图，不提供可选中文文本；可编辑内容以 PPTX 为准。由于 PPTX 使用系统字体替代，字距可能与固定渲染的 PDF 有轻微差异；所有正文均使用显式分行与安全边距来降低重排风险。
