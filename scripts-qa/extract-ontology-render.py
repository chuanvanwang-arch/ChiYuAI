#!/usr/bin/env python3
# scripts-qa/extract-ontology-render.py — 从混合文件 ontologyConfig.js 抽取渲染区生成 ontologyConfigRender.js
# 本会话 QA 根因 A 教训：渲染纯函数与服务端 Router 必须分文件，浏览器原生 ESM 才可加载。
# 结构（ontologyConfig.js 224 行）：
#   1-8   头注释
#   9-13  服务端 import（express/db.js/decisionRepo/auth/particleModel —— 浏览器加载必崩）
#   15-117 渲染区（VOCAB_EDITABLE_FIELDS/VOCAB_STATES/validateVocabularyPatch/renderVocabulary/
#          CORE_PARTICLE_IDS/PARTICLE_MODEL/renderModelSnapshot —— 浏览器要的）
#   119-155 defaultDeps（服务端依赖 query/recordDecisionEvent/resolveMe）
#   157-165 slugify（渲染辅助，renderModelSnapshot 引用）
#   166-224 Router 区（createOntologyRouter）
# 输出：ontologyConfigRender.js = 15-117 渲染区 + 157-165 slugify（零服务端 import）
#       ontologyConfig.js 保留 1-13 import + 119-155 defaultDeps + 166-224 Router
import re

SRC = 'src/portal/ontologyConfig.js'
DST = 'src/portal/ontologyConfigRender.js'

lines = open(SRC, encoding='utf-8').read().split('\n')
total = len(lines)
print(f'{SRC} 总行数: {total}')

# 【切 1】验证边界行内容，防止行号漂移后切错
check = {
    14: lines[13],   # import { PARTICLE_TYPES... 行（最后一个 import）
    16: lines[15],   # // —— 纯函数：validateVocabularyPatch ——
    17: lines[16],   # export const VOCAB_EDITABLE_FIELDS
    117: lines[116],  # }（renderModelSnapshot 结束）
    119: lines[118],  # // —— 端点（注入式依赖...
    157: lines[156],  # function slugify(s)
    166: lines[165],  # export function createOntologyRouter
}
for ln, content in check.items():
    print(f'  边界行 {ln}: {content[:70]}')

# 断言边界
assert re.match(r'^export const VOCAB_EDITABLE_FIELDS', lines[16]), '17 行应为 VOCAB_EDITABLE_FIELDS 开头'
assert re.match(r'^export function createOntologyRouter', lines[165]), '166 行应为 createOntologyRouter'
assert 'function slugify' in lines[156], '157 行应为 slugify'

# 【切 2】渲染区 = 行 16-117 → index 15-116：剔除 9-14 服务端 import（index 8-13），留渲染导出
render_part = []
# 先取 import 行（9-13 → index 8-12）：纯数据粒子模型 import 保留，服务端 import 剔除
for i in range(8, 13):  # 行号 9-13
    l = lines[i]
    if re.match(r'^import .*from .*particles/particleModel\.js', l):
        render_part.append(l)  # 纯数据依赖，浏览器可加载（particleModel.js 零服务端 import）
    # 其余（express/db.js/decisionRepo/auth）剔除
for i in range(15, 117):  # 行号 16-117 → index 15-116：渲染导出区
    l = lines[i]
    if re.match(r'^import ', l):
        continue  # 保险：剔除任何残留 import
    if l.startswith('// src/portal/ontologyConfig.js'):
        l = '// 渲染纯函数子模块（浏览器 + vitest 共用；服务端逻辑见 ontologyConfig.js）'
    render_part.append(l)

# 【切 3】slugify（157-165 → index 156-164）
slugify_part = lines[156:165]

# 【拼】输出 Render 子模块
out = []
out.append('// src/portal/ontologyConfigRender.js — 粒子模型/本体/词汇配置（22 项）渲染纯函数子模块')
out.append('// QA 根因 A（混合模块浏览器 ESM 崩溃）教训：本文件零服务端 import，浏览器可原生加载。')
out.append('// 服务端 Router/依赖在 ontologyConfig.js（defaultDeps+createOntologyRouter），渲染与路由严格分文件。')
out.append('')
out.extend(render_part)
out.append('')
out.extend(slugify_part)

final = '\n'.join(out)
open(DST, 'w', encoding='utf-8').write(final)

# 【验证】零服务端 import + 所需导出齐全
print(f'\n=== 验证 {DST} ===')
err = 0
code_lines = [l for l in final.split('\n') if not l.strip().startswith('//')]
for l in code_lines:
    # 只允许纯数据依赖（particles/particleModel.js）；其余服务端 import 为残留
    if re.match(r'^import .*from .*particles/particleModel\.js', l):
        continue
    if re.match(r'^import ', l):
        print('!!! 残留服务端 import:', l)
        err += 1
code_text = '\n'.join(code_lines)  # 源码文本（非逐行），用于子串检查
for need in ['VOCAB_EDITABLE_FIELDS', 'VOCAB_STATES', 'validateVocabularyPatch', 'renderVocabulary',
             'CORE_PARTICLE_IDS', 'PARTICLE_MODEL', 'renderModelSnapshot', 'slugify']:
    if need not in code_text:
        print('!!! 缺失导出:', need)
        err += 1
if 'createOntologyRouter' in code_text:
    print('!!! Render 子模块不应含 createOntologyRouter')
    err += 1
print(f'总行数: {len(final.split(chr(10)))}')
print('验证', 'PASS' if err == 0 else f'FAIL ({err})')