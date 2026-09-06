#!/usr/bin/env python3
# 抽取混合 portal 模块的渲染纯函数区 → 生成浏览器可加载的 *Render.js 子模块
# 根因：approvalFlow/alertRuleConfig/mcpIdentity/businessTier/decisionScenario/rbacMatrix/userManagement
#       顶层 import express/../db.js/../decision/../alerts（Node-only）→ 浏览器 ESM 加载崩溃
#       （报 "Failed to resolve module specifier 'express'"）→ 页面脚本整体崩溃
# 修复：渲染纯函数抽到 *Render.js；页面 import 改指向它；服务端 router 留在原文件。
# 切分：cut_exclusive = 服务端区起始行号（渲染区为其前所有行）
# 用法: python scripts-qa/extract-render-modules.py
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
PORTAL = ROOT / 'src' / 'portal'

# (源文件, 目标子模块, 服务端区起始行号 cut_exclusive)
CASES = [
    ('approvalFlow.js',       'approvalFlowRender.js',       76),
    ('alertRuleConfig.js',    'alertRuleConfigRender.js',    74),
    ('mcpIdentity.js',        'mcpIdentityRender.js',        61),
    ('businessTier.js',       'businessTierRender.js',       42),
    ('decisionScenario.js',   'decisionScenarioRender.js',  102),
    ('rbacMatrix.js',         'rbacMatrixRender.js',        114),
    ('userManagement.js',     'userManagementRender.js',    101),
]

HEADER_TMPL = """// src/portal/{dst} — {dst} 渲染纯函数子模块（浏览器 ESM 可加载）
// 根因修复（2026-08-27）：源 {src} 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../alerts/*）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃（列表不渲染/按钮不绑定）。
// 本文件仅含渲染纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 {src}（routes.js 继续 import 它）；页面 import 改指向本文件。

"""


def build_render_module(src_name: str, dst_name: str, cut: int) -> str:
    src_lines = (PORTAL / src_name).read_text(encoding='utf-8').split('\n')
    render_lines = src_lines[:cut]
    # 剔除渲染区残留的顶层 import（防误包服务端依赖；渲染区本不应有）
    render_lines = [ln for ln in render_lines if not re.match(r'^\s*import\s', ln)]
    # 去尾部空行/注释悬空
    while render_lines and (not render_lines[-1].strip() or render_lines[-1].strip().startswith('//')):
        render_lines.pop()
    body = '\n'.join(render_lines).strip()
    header = HEADER_TMPL.format(src=src_name, dst=dst_name)
    return header + body + '\n'


for src_name, dst_name, cut in CASES:
    dst = PORTAL / dst_name
    mod = build_render_module(src_name, dst_name, cut)
    dst.write_text(mod, encoding='utf-8')
    print(f'✓ {src_name} → {dst_name} (cut@{cut}) {dst.stat().st_size} bytes')

print('\n完成。下一步：改 7 个页面 import 指向 *Render.js，运行 browserLoadable.test.js 验证 GREEN。')