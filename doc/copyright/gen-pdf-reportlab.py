# 用 reportlab 确定性生成「程序鉴别材料」PDF：每页精确 50 行，A4，带页眉页脚
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm

SOFTWARE = "AI 原生智能销售管理平台（CRM-AI-Native）"
VERSION = "V1.0"
LINES_PER_PAGE = 50

with open('doc/copyright/source-lines.txt', encoding='utf-8') as f:
    lines = f.read().split('\n')

# 去除文件末尾可能产生的空行
while lines and lines[-1] == '':
    lines.pop()

total = len(lines)
pages = (total + LINES_PER_PAGE - 1) // LINES_PER_PAGE

W, H = A4
left = 12 * mm
right = 12 * mm
top = 14 * mm
bottom = 14 * mm

code_font = 7
line_h = 8.5
y_start = H - top - 16  # 页眉线下方起笔

c = canvas.Canvas('doc/copyright/source-material.pdf', pagesize=A4)
for pg in range(pages):
    chunk = lines[pg * LINES_PER_PAGE:(pg + 1) * LINES_PER_PAGE]
    # 页眉
    c.setFont('Helvetica', 7.5)
    c.drawString(left, H - top,
                 f"{SOFTWARE} {VERSION} — 源程序鉴别材料（一般交存）　第 {pg + 1} 页 / 共 {pages} 页")
    c.line(left, H - top - 2, W - right, H - top - 2)
    # 代码（超长行截断至 200 字符，避免横向溢出）
    c.setFont('Courier', code_font)
    y = y_start
    for ln in chunk:
        c.drawString(left, y, ln[:200])
        y -= line_h
    # 页脚
    c.setFont('Helvetica', 6.5)
    c.drawRightString(W - right, bottom - 2, f"{SOFTWARE} {VERSION}")
    c.showPage()

c.save()
print(f"源程序总行数: {total}，生成页数: {pages}")
