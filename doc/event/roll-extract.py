# -*- coding: utf-8 -*-
"""滚动提取 doc 占位段全文：doc_find 上下文窗口（前后各30字）滚动拼接"""
import subprocess, json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

EDSDK = r"C:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/tencent-local-office-edit/edsdk.py"
FID = "36338346-4949-43bd-b49d-cacbaa62cdb6"

def find(text):
    r = subprocess.run([sys.executable, EDSDK, "call", "doc_find", "--json",
                        json.dumps({"file_id": FID, "text": text})],
                       capture_output=True, text=True, encoding='utf-8')
    d = json.loads(r.stdout)
    return d.get("locations", [])

def roll_full(seed, stop_words, max_iter=30):
    """从 seed 开始，向后滚动拼接段文本，直到后文出现 stop_words（下一节标题）"""
    locs = find(seed)
    if not locs:
        return None
    text = seed
    for _ in range(max_iter):
        # 用已知尾部最多20字作为查询
        q = text[-20:]
        locs = find(q)
        if not locs:
            break
        best = None
        for l in locs:
            b = l["begin"]
            # 匹配必须在当前文本起点之后的段落里（取 begin 最小的）
            if best is None or b < best["begin"]:
                best = l
        rel = best.get("related_text", "")
        after = rel.split("]", 1)[1] if "]" in rel else ""
        if not after:
            break
        stop_at = len(after)
        for w in stop_words:
            i = after.find(w)
            if i != -1:
                stop_at = min(stop_at, i)
        if stop_at <= 0:
            break
        text += after[:stop_at]
        if stop_at < len(after):
            break
    return text

SEEDS = {
    "摘要":   ("项目的背景、项目方案等简介说明等", ["案例-主要创新"]),
    "主要创新": ("言简意赅，突出亮点", ["案例-应用成效"]),
    "应用成效": ("用关键数据量化呈现", ["案例-项目背景"]),
    "项目背景": ("从行业/政策趋势", ["案例-项目方案"]),
    "项目方案": ("介绍项目的总体情况", ["案例-创新点（500"]),
    "创新点500": ("突出关键功能、技术上的先进性", ["案例-应用效益"]),
    "应用效益": ("用数据或事实说明项目带来的实际成效", ["第五部分"]),
    "技术要点1": ("技术架构与先进性：详细说明", ["功能体系与业务流程"]),
    "技术要点2": ("功能体系与业务流程：系统介绍", ["资源配置"]),
    "技术要点3": ("资源配置：明确", ["部署方案与预期效果"]),
    "技术要点4": ("部署方案与预期效果：阐述", ["创新点（1000"]),
    "创新点1000": ("系统总结项目在技术架构", ["项目信息表", "项目信息表（"]),
}

out = {}
for k, (seed, stops) in SEEDS.items():
    t = roll_full(seed, stops)
    out[k] = t
    print(f"== {k} ==")
    print(t)
    print()
