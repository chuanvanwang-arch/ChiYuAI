# -*- coding: utf-8 -*-
"""构建 AI 原生销售管理平台介绍 PPT（专家版 · 通用 B2B 销售案例 · ~19 页）
四幕闭环：客户痛点 → 问题分析 → 解决方案（AI 原生销售管理助手专家包 + 7 方法论 + 真实案例）
           → 客户价值（闭环量化 + 落地路径）
"""
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

# ---------- 设计 token（与演示 HTML 同源）----------
BG    = RGBColor(0x0c,0x0e,0x14)
BG2   = RGBColor(0x13,0x16,0x1e)
CARD  = RGBColor(0x1a,0x1e,0x2a)
CYAN  = RGBColor(0x22,0xd3,0xee)
AMBER = RGBColor(0xfb,0xbf,0x24)
GREEN = RGBColor(0x34,0xd3,0x99)
RED   = RGBColor(0xf8,0x71,0x71)
PURPLE= RGBColor(0xa7,0x8b,0xfa)
BLUE  = RGBColor(0x60,0xa5,0xfa)
WHITE = RGBColor(0xe8,0xea,0xed)
GRAY  = RGBColor(0x9a,0xa0,0xb0)
DIM   = RGBColor(0x5c,0x62,0x78)
BORDER= RGBColor(0x25,0x2a,0x3a)
FONT  = 'Microsoft YaHei'

prs = Presentation()
prs.slide_width  = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]

def bg(slide, color=BG):
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = color

def txt(slide, l,t,w,h, text, size=18, color=WHITE, bold=False,
        align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing=1.2, font=FONT):
    tb = slide.shapes.add_textbox(Inches(l),Inches(t),Inches(w),Inches(h))
    tf = tb.text_frame; tf.word_wrap = True; tf.vertical_anchor = anchor
    for i,line in enumerate(text.split('\n')):
        p = tf.paragraphs[0] if i==0 else tf.add_paragraph()
        p.alignment = align; p.line_spacing = spacing
        r = p.add_run(); r.text = line
        r.font.size = Pt(size); r.font.bold = bold
        r.font.color.rgb = color; r.font.name = font
    return tb

def card(slide, l,t,w,h, fill=CARD, line=BORDER, lw=1.0, radius=0.08):
    sh = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
        Inches(l),Inches(t),Inches(w),Inches(h))
    sh.fill.solid(); sh.fill.fore_color.rgb = fill
    sh.line.color.rgb = line; sh.line.width = Pt(lw)
    try: sh.adjustments[0] = radius
    except Exception: pass
    sh.shadow.inherit = False
    return sh

def pill(slide, l,t,w,h, text, color=CYAN, fill=BG2, size=12):
    sh = card(slide,l,t,w,h,fill=fill,line=color,lw=1.0,radius=0.5)
    tf = sh.text_frame; tf.word_wrap=True; tf.vertical_anchor=MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]; p.alignment=PP_ALIGN.CENTER
    r=p.add_run(); r.text=text; r.font.size=Pt(size); r.font.bold=True
    r.font.color.rgb=color; r.font.name=FONT
    return sh

def header(slide, act, actname, title):
    txt(slide,0.6,0.45,3,0.4, act, 13, CYAN, True)
    txt(slide,0.6,0.82,11.5,0.95, title, 30, WHITE, True)
    txt(slide,0.6,1.78,11.5,0.4, actname, 14, GRAY)

def newslide():
    s = prs.slides.add_slide(BLANK); bg(s); return s

# =====================================================================
# 1 · 封面（专家定位）
# =====================================================================
s = newslide()
txt(s,0.9,1.35,6,0.5,'AI-NATIVE SALES EXPERT',13,CYAN,True)
txt(s,0.9,1.9,11,1.4,'AI 原生销售管理助手',46,WHITE,True)
txt(s,0.9,3.35,11,0.7,'在 WorkBuddy 里直接对话',24,AMBER,True)
txt(s,0.9,4.3,11,1.3,
    '不是把流程搬到线上，\n而是让报价、跟进、复购、管理，自己推进、自己校验、自己闭环。\n专家已上架技能市场，办公智能体一键召唤。',
    16,GRAY,False,spacing=1.3)
pill(s,0.9,6.15,4.4,0.55,'专家包 · 7 方法论 · 多智能体',CYAN,BG2,12)

# =====================================================================
# 2 · 导读 AGENDA
# =====================================================================
s = newslide()
header(s,'导读 · AGENDA','本次交流，四件事','从行业之痛，到根因之判，再到专家之治与价值之验')
agenda = [
    ('01','客户痛点','B2B 销售，为什么越来越难'),
    ('02','问题分析','传统 CRM，为何解不了这些痛'),
    ('03','解决方案','AI 原生销售管理助手（专家包）'),
    ('04','客户价值','痛点如何被逐一化解'),
]
x = 0.9
for n,t1,t2 in agenda:
    card(s,x,2.5,2.85,3.4)
    txt(s,x+0.25,2.75,2.4,0.8,n,40,CYAN,True)
    txt(s,x+0.25,3.75,2.4,0.5,t1,19,WHITE,True)
    txt(s,x+0.25,4.4,2.4,1.2,t2,14,GRAY,False,spacing=1.25)
    x += 3.05

# =====================================================================
# 3 · 第一幕 痛点总览
# =====================================================================
s = newslide()
header(s,'01 · 客户痛点','B2B 销售管理，为什么越来越难','五道关卡同时加压，传统 CRM 却帮不上忙')
pains = ['报价复杂易错','订单信息断层','利润核算滞后','交期产能脱节','客户资产分散']
x=0.9
for i,p in enumerate(pains):
    card(s,x,2.5,2.2,1.5)
    txt(s,x+0.2,2.75,1.8,0.5,f'0{i+1}',18,AMBER,True)
    txt(s,x+0.2,3.25,1.9,0.7,p,16,WHITE,True)
    x += 2.42
txt(s,0.9,4.4,11.5,1.4,
    'B2B 销售产品/方案高度复杂（配置、参数、交付条件组合多），依赖人工经验；\n「报高了丢单、报低了亏本」；利润等交付完才知道；\n客户分散、跟进靠 Excel，人员一走客户就丢。',
    16,GRAY,False,spacing=1.35)

# =====================================================================
# 4 · 五大核心痛点详解
# =====================================================================
s = newslide()
header(s,'01 · 客户痛点','B2B 销售五大核心痛点（详解）','每一项都直指利润与效率')
data = [
    ('报价错','定制化组合万千，依赖人工估算，漏项算错损耗，「报高丢单、报低亏本」，周期长影响成交。',RED),
    ('订单断层','需求/配置参数手写或 Excel 流转易遗漏，交付端偏差致返工与客诉。',RED),
    ('利润滞后','纸价波动大、损耗生产后才统计，接单时无法预判毛利，「忙季不赚钱」。',AMBER),
    ('交期冲突','为抢单过度承诺，缺实时产能支撑，插单频繁、延期损信任。',AMBER),
    ('客资分散','中小客户靠 Excel/纸质，历史报价偏好未沉淀，离职即流失。',RED),
]
positions = [(0.9,2.5),(6.5,2.5),(0.9,4.2),(6.5,4.2),(0.9,5.9)]
for (p,d,c),(l,t) in zip(data, positions):
    card(s,l,t,5.4,1.55)
    txt(s,l+0.25,t+0.18,2.0,0.5,p,18,WHITE,True)
    txt(s,l+0.25,t+0.72,5.0,0.75,d,13,GRAY,False,spacing=1.2)

# =====================================================================
# 5 · 衍生管理困境
# =====================================================================
s = newslide()
header(s,'01 · 客户痛点','衍生管理困境：痛点之上的系统性失血','单点痛点积累，演变为经营层面的结构性问题')
subs = [
    ('业财数据割裂','合同、领料、收款不同步，管理层无法实时掌握真实盈利，决策靠滞后报表。',RED),
    ('非标难标准化','个性化需求难转标准 SKU，常现「有单无料」或呆滞积压。',AMBER),
    ('价格战利润挤压','同质化竞争无数据支撑差异化报价，被迫低价恶性循环。',AMBER),
]
x=0.9
for t,d,c in subs:
    card(s,x,2.6,3.7,3.3)
    txt(s,x+0.25,2.9,3.2,0.6,t,19,WHITE,True)
    txt(s,x+0.25,3.7,3.2,1.9,d,14,GRAY,False,spacing=1.3)
    x += 3.9

# =====================================================================
# 6 · 第二幕 三道鸿沟
# =====================================================================
s = newslide()
header(s,'02 · 问题分析','传统 CRM，方案与落地之间隔着三道鸿沟','鸿沟的本质：人驱动的流程，在复杂度面前到达极限')
gaps = [
    ('场景鸿沟','销售场景千变万化，固定表单与工作流覆盖不了真实场景。',CYAN),
    ('数据鸿沟','只记录「发生了什么」，缺失「为什么这样决策」的上下文。',AMBER),
    ('决策鸿沟','CRM 不替你做判断，资深销售的判断留在人脑，无法沉淀复用。',GREEN),
]
x=0.9
for t,d,c in gaps:
    card(s,x,2.6,3.7,3.3,fill=BG2,line=c)
    txt(s,x+0.25,2.9,3.2,0.6,t,20,c,True)
    txt(s,x+0.25,3.7,3.2,1.9,d,14,GRAY,False,spacing=1.3)
    x += 3.9
txt(s,0.9,6.1,11.5,0.6,'结论：传统 CRM 把「人填表」自动化了，却没解决「人判断」的问题。',15,CYAN,True)

# =====================================================================
# 7 · 根因：数据库 vs 记忆系统
# =====================================================================
s = newslide()
header(s,'02 · 问题分析','根因：它是数据库，不是记忆系统','一句话区分 AI 原生 CRM 与传统 CRM 的本质')
card(s,0.9,2.6,5.4,3.6,fill=BG2,line=RED)
txt(s,0.9+0.3,2.85,5.0,0.5,'传统 CRM',20,RED,True)
txt(s,0.9+0.3,3.55,5.0,2.4,
    '· 记录「发生了什么」\n· 状态、日志、字段填录\n· 人负责判断，系统只负责存\n· 越用越臃肿，不越聪明',
    16,WHITE,False,spacing=1.5)
card(s,6.5,2.6,5.4,3.6,fill=BG2,line=CYAN)
txt(s,6.5+0.3,2.85,5.0,0.5,'AI 原生销售管理助手',20,CYAN,True)
txt(s,6.5+0.3,3.55,5.0,2.4,
    '· 记录「为什么被允许发生」\n· 决策事件 + 先例网沉淀\n· 智能体负责判断与执行\n· 越用越聪明，飞轮自驱',
    16,WHITE,False,spacing=1.5)
txt(s,0.9,6.4,11.5,0.5,'判据：只答 What 是数据库；能答 Why 才是记忆系统。',16,AMBER,True)

# =====================================================================
# 8 · 第三幕 专家包总览
# =====================================================================
s = newslide()
header(s,'03 · 解决方案','AI 原生销售管理助手（专家包）','在 WorkBuddy 里一键召唤，让系统替销售做判断、做闭环')
caps = [
    ('意图路由','一句话 → 自动分发到对应技能（查/写/风险）',CYAN),
    ('角色自适应','不问你是谁，按对话内容推断角色加载上下文',AMBER),
    ('7 大方法论','BANT/MEDDICC/机会矩阵/角色地图/风险权衡/止损点/事实vs话术',GREEN),
    ('先于提问预警','链断裂/回款逾期/方案缺口，主动 SSE 推送',RED),
]
x=0.9; y=2.6
for i,(t,d,c) in enumerate(caps):
    card(s,x,y,5.4,1.9,fill=BG2,line=c)
    txt(s,x+0.3,y+0.25,5.0,0.5,f'能力 {i+1} · {t}',19,WHITE,True)
    txt(s,x+0.3,y+1.0,5.0,0.7,d,14,GRAY,False,spacing=1.2)
    x = 0.9 if i%2==0 else 6.5
    y = 2.6 if i%2==0 else 4.8
txt(s,0.9,6.75,11.5,0.5,'封装：方法论 SKILL + MCP Server + CRM 智能体包 → WorkBuddy 技能市场安装。',13,DIM,True)

# =====================================================================
# 9 · 7 大方法论（2B 销售决策）
# =====================================================================
s = newslide()
header(s,'03 · 解决方案 · 专家能力','7 大决策方法论，固化进智能体','2B 销售每一步决策都有方法，不是拍脑袋')
methods = [
    ('BANT','预算/权限/需求/时间线','线索初筛',CYAN),
    ('MEDDICC','痛点/经济买家/决策标准/流程','机会真假',PURPLE),
    ('机会矩阵','价值 × 赢率','资源投入',BLUE),
    ('角色地图','决策链/影响者/使用者','主攻谁',AMBER),
    ('风险权衡','风险 × 收益/红线','签不签单',RED),
    ('止损点','负净值/投入预算/退出门','何时退出',AMBER),
    ('事实vs话术','事实/证据/话术/异议','不被忽悠',GREEN),
]
positions = [(0.9,2.4),(4.7,2.4),(8.5,2.4),(0.9,4.0),(4.7,4.0),(8.5,4.0),(0.9,5.6)]
for (t,d,u,c),(l,ty) in zip(methods, positions):
    card(s,l,ty,3.5,1.4,fill=BG2,line=c)
    txt(s,l+0.22,ty+0.15,3.1,0.5,t,17,c,True)
    txt(s,l+0.22,ty+0.72,3.1,0.45,d,12.5,GRAY,False,spacing=1.1)
    txt(s,l+0.22,ty+1.08,3.1,0.35,f'用途：{u}',11,DIM,False,spacing=1.0)
txt(s,0.9,7.0,11.5,0.4,'每个方法论独立 SKILL（method-*），附 registry + profiles + 评分规则，可独立调用。',13,DIM,True)

# =====================================================================
# 10 · 真实案例一：系统方案报价（A/B 两方案）
# =====================================================================
s = newslide()
header(s,'03 · 解决方案 · 真实案例','案例一：系统方案报价（两套方案 A/B）','对话式报价：专家按配置/成本/毛利自动测算，两方案供客户选')
# 需求侧
card(s,0.9,2.4,5.4,2.0,fill=BG2,line=CYAN)
txt(s,1.1,2.55,5.0,0.5,'客户需求（一句话）',16,CYAN,True)
txt(s,1.1,3.15,5.0,1.1,
    '「生产管理系统，50 个用户节点，含实施培训，下季度上线，杭州交付，开专票」',
    13.5,WHITE,False,spacing=1.3)
# 方案 A
card(s,6.5,2.4,5.4,1.7,fill=BG2,line=GREEN)
txt(s,6.7,2.55,5.0,0.5,'方案 A · 经济型（走量让利）',16,GREEN,True)
txt(s,6.7,3.15,5.0,0.9,
    '不含税 ¥2,800/节点 · 价税合计 ¥15.8 万（13% 专票）\n适用：预算敏感 / 首批试点 / 长期量大可谈阶梯价',
    13.5,GRAY,False,spacing=1.25)
# 方案 B
card(s,6.5,4.2,5.4,1.7,fill=BG2,line=AMBER)
txt(s,6.7,4.35,5.0,0.5,'方案 B · 标准商务版（含服务冗余）',16,AMBER,True)
txt(s,6.7,4.95,5.0,0.9,
    '不含税 ¥3,400/节点 · 价税合计 ¥19.2 万（13% 专票）\n适用：常规商务合作，含品质管控/优先实施/培训支持',
    13.5,GRAY,False,spacing=1.25)
# 成本与规则
txt(s,0.9,4.6,5.6,2.3,
    '成本结构（专家可透视）：软件许可 ¥6 万 + 实施 ¥3 万 + 硬件 ¥2 万 = 不含税 ¥11 万\n\n商务规则已自动附着：\n· 首年免费维护，续费享老客户价\n· 量达 80 节点享阶梯价\n· 方案修订免费 1 次，之后按变更计费',
    13,GRAY,False,spacing=1.35)

# =====================================================================
# 11 · 真实案例二：客户需求一句话 → 缺失项自动追问补齐
# =====================================================================
s = newslide()
header(s,'03 · 解决方案 · 真实案例','案例二：客户需求「一句话 → 缺失项自动追问补齐」','专家不等废话，主动把必填项问齐')
# 客户原文
card(s,0.9,2.4,5.4,2.0,fill=BG2,line=GREEN)
txt(s,1.1,2.55,5.0,0.5,'客户微信原文',16,GREEN,True)
txt(s,1.1,3.15,5.0,1.0,
    '「想上一套客户管理系统，大概几十个人用，要能对接我们现有的 ERP，最好下个月能上线，报个价。」',
    13.5,WHITE,False,spacing=1.3)
txt(s,1.1,4.3,5.0,0.4,'→ 专家自动解析为结构化需求',13,CYAN,True)
# 已明确 vs 缺失
card(s,6.5,2.4,5.4,1.6,fill=BG2,line=GREEN)
txt(s,6.7,2.55,5.0,0.5,'已明确（可直接进方案）',16,GREEN,True)
txt(s,6.7,3.15,5.0,0.8,'CRM · 对接 ERP · 几十人 · 下月上线 · 询价 · 含现有系统',14,GRAY,False,spacing=1.2)
card(s,6.5,4.15,5.4,1.9,fill=BG2,line=RED)
txt(s,6.7,4.3,5.0,0.5,'缺失项（自动追问，阻塞报价/排期）',16,RED,True)
txt(s,6.7,4.9,5.0,1.1,
    '① 用户数精确 ② 模块范围 ③ 公有云/私有化 ④ 是否含定制开发\n⑤ 数据迁移范围 ⑥ 验收标准 ⑦ 是否 POC ⑧ 精确上线日',
    13.5,GRAY,False,spacing=1.25)
txt(s,0.9,5.5,5.4,1.6,
    '价值：一个微信来回，就把「报价前必确认」清单自动生成；\n缺用户数可先报「参考价区间」稳住客户，注明以最终规模为准。',
    13.5,AMBER,False,spacing=1.3)

# =====================================================================
# 12 · 真实案例三：交期产能冲突预警
# =====================================================================
s = newslide()
header(s,'03 · 解决方案 · 真实案例','案例三：交付风险冲突 → 先于提问的预警','专家不等销售问，主动探测链断裂并推送')
# 场景
card(s,0.9,2.4,5.4,1.8,fill=BG2,line=CYAN)
txt(s,1.1,2.55,5.0,0.5,'场景',16,CYAN,True)
txt(s,1.1,3.15,5.0,0.9,
    '销售为抢单承诺「2 周上线」，但实施资源已排满；\n商机进入机会阶段 >30 天仍无技术方案；回款逾期 2 笔。',
    14,WHITE,False,spacing=1.3)
# 预警
card(s,6.5,2.4,5.4,3.0,fill=BG2,line=RED)
txt(s,6.7,2.55,5.0,0.5,'专家主动推送（SSE）',16,RED,True)
txt(s,6.7,3.15,5.0,2.0,
    '「3 条商机缺技术方案已超 30 天」\n「2 笔回款逾期，需按金额与账期定催收优先级」\n「上线承诺 vs 交付资源缺口：本周插单 1 单将挤占 A 客户排期」\n→ 建议：重新核算上线周期 / 升级催收 / 调整排期',
    14,GRAY,False,spacing=1.35)
txt(s,0.9,6.4,11.5,0.6,'识别模式：商机→技术方案>30 天 / 赢单前无方案 / 回款逾期 / 阶段只进不退异常。',13.5,DIM,True)

# =====================================================================
# 13 · 真实案例四：年度订单复盘（成交 12.6 万 → 经验沉淀 → 复购转化）
# =====================================================================
s = newslide()
header(s,'03 · 解决方案 · 真实案例','案例四：年度订单复盘 → 经验沉淀 → 复购转化','过程有问题、结果很成功——复盘把问题变成下次盈利')
card(s,0.9,2.4,5.4,2.0,fill=BG2,line=AMBER)
txt(s,1.1,2.55,5.0,0.5,'复盘基本盘',16,AMBER,True)
txt(s,1.1,3.15,5.0,1.1,
    '年度系统采购 1 单 · 成交 ¥12.6 万（客单价约 ¥12.6 万/单）\n客户满意 + 有增购意向；过程中：需求变更 3 次 + 联调返工 1 次',
    14,WHITE,False,spacing=1.3)
card(s,6.5,2.4,5.4,3.0,fill=BG2,line=GREEN)
txt(s,6.7,2.55,5.0,0.5,'专家复盘输出',16,GREEN,True)
txt(s,6.7,3.15,5.0,2.0,
    '根因：需求变更没设闸门 + 验收未书面锁死（流程问题，非客户难缠）\n沉淀：变更免费 1-2 次、第 3 次起收费 + 工期顺延；验收即锁\n复购：满意是「易耗资产」→ 3 天感谢预告 / 7 天翻单价 / 30 天推增值模块\n¥12.6 万 → 同类项目报价锚点',
    14,GRAY,False,spacing=1.35)

# =====================================================================
# 14 · 第四幕 痛点逐一对治
# =====================================================================
s = newslide()
header(s,'04 · 客户价值','痛点如何被逐一化解（闭环咬合）','前面每一个痛，都有对应的能力来治')
rows = [
    ('报价错 / 利润滞后','方法论报价测算 + 记忆','接单即预判毛利，A/B 两方案有据'),
    ('订单断层 / 返工','对话即捕获，意图留痕','需求参数不丢，交付端零误解'),
    ('交付冲突','crm-risk 链断裂预警','交付/回款实时可视，先于提问预警'),
    ('客资分散 / 流失','客户记忆层','历史沉淀不丢，离职带不走客户'),
    ('销售越做越累','多智能体 + 商机分级','分级自动跑，人只管关键客户'),
]
card(s,0.9,2.5,3.6,0.6,fill=BG2,line=CYAN); txt(s,1.15,2.62,3.2,0.4,'客户痛点',15,CYAN,True)
card(s,4.6,2.5,3.6,0.6,fill=BG2,line=AMBER); txt(s,4.85,2.62,3.2,0.4,'对应能力',15,AMBER,True)
card(s,8.3,2.5,4.1,0.6,fill=BG2,line=GREEN); txt(s,8.55,2.62,3.7,0.4,'带来的改善',15,GREEN,True)
y=3.15
for p,c,v in rows:
    card(s,0.9,y,3.6,0.78,fill=CARD,line=BORDER)
    txt(s,1.1,y+0.16,3.3,0.5,p,13,WHITE,False,spacing=1.0)
    card(s,4.6,y,3.6,0.78,fill=CARD,line=BORDER)
    txt(s,4.8,y+0.16,3.3,0.5,c,13,GRAY,False,spacing=1.0)
    card(s,8.3,y,4.1,0.78,fill=CARD,line=BORDER)
    txt(s,8.5,y+0.16,3.8,0.5,v,13,GREEN,False,spacing=1.0)
    y += 0.84

# =====================================================================
# 15 · 记忆飞轮 + 四重价值
# =====================================================================
s = newslide()
header(s,'04 · 客户价值','越用越聪明：记忆飞轮 + 四重价值','系统不是工具，而是会自检、会建议、会进化的销售中枢')
card(s,0.9,2.6,5.4,3.4,fill=BG2,line=CYAN)
txt(s,0.9+0.3,2.85,5.0,0.5,'记忆飞轮',20,CYAN,True)
txt(s,0.9+0.3,3.55,5.0,2.3,
    '捕获 Capture → 拼装 Assemble\n→ 决策 Decide → 回流 Feedback\n\n每一圈，先例更丰富、判断更准、\n人更省心。',
    16,WHITE,False,spacing=1.5)
vals = [('减负','销售告别手工填表',GREEN),('提效','报价跟进自动推进',CYAN),
        ('保客','客户资产不流失',AMBER),('增收','数据支撑价值报价',RED)]
pos = [(6.5,2.6),(9.45,2.6),(6.5,4.35),(9.45,4.35)]
for (t,d,c),(px,py) in zip(vals,pos):
    card(s,px,py,2.75,1.6,fill=BG2,line=c)
    txt(s,px+0.2,py+0.2,2.4,0.5,t,18,c,True)
    txt(s,px+0.2,py+0.8,2.4,0.7,d,13,GRAY,False,spacing=1.2)

# =====================================================================
# 16 · 交付方式：WorkBuddy 一键召唤
# =====================================================================
s = newslide()
header(s,'04 · 客户价值','交付方式：在 WorkBuddy 里一键召唤','装进技能市场，办公智能体免登录调用')
steps = [
    ('打开 WorkBuddy','左侧「专家 · 技能 · 连接器」进入技能市场',CYAN),
    ('安装「AI 原生销售管理助手」','搜索安装，一键召唤，开启专属对话',AMBER),
    ('自然语言干活','查商机 / 一句话写入 / 链预警 / 方法论评估',GREEN),
]
x=0.9
for t,d,c in steps:
    card(s,x,2.6,3.7,3.3,fill=BG2,line=c)
    txt(s,x+0.25,2.9,3.2,0.6,t,19,c,True)
    txt(s,x+0.25,3.7,3.2,1.9,d,14,GRAY,False,spacing=1.3)
    x += 3.9
txt(s,0.9,6.2,11.5,0.8,
    '底层：方法论 SKILL（7 个 method-*）+ MCP Server（stdio + StreamableHTTP 双传输）+ CRM 智能体包（crm-native 编排 / crm-query 查询 / crm-write 两阶段写入 / crm-risk 预警）。',
    13,GRAY,False,spacing=1.3)

# =====================================================================
# 17 · 角色自适应：千人千面
# =====================================================================
s = newslide()
header(s,'04 · 客户价值','角色自适应：同一句话，不同视角','不问你是谁，系统自推断角色并加载对应上下文')
roles = [
    ('销售','「看看今天的商机」→ 待办优先级 + 超期预警',GREEN),
    ('销售经理','「这周团队情况」→ 团队管道看板 + 低转化成员',BLUE),
    ('高管','「华东 vs 华南签约」→ 区域对比 + 季度预测',PURPLE),
    ('财务','「看看逾期回款」→ 应收全景 + 催收优先级',AMBER),
    ('商务','「哪些合同快到期」→ 到期清单 + 续约建议',CYAN),
]
y=2.5
for t,d,c in roles:
    card(s,0.9,y,11.3,0.78,fill=BG2,line=c)
    txt(s,1.15,y+0.17,2.6,0.5,t,15,c,True)
    txt(s,3.9,y+0.17,8.0,0.5,d,13.5,GRAY,False,spacing=1.1)
    y += 0.86

# =====================================================================
# 18 · 结语 · 实施路径
# =====================================================================
s = newslide()
header(s,'结语 · WHAT\'S NEXT','从「数据库」到「记忆系统」','建议下一步：用真实数据说话')
txt(s,0.9,2.5,11.5,1.0,
    '先装「AI 原生销售管理助手」，用 4 周跑通「一般商机全自动闭环」——\n自动接诊、标准报价、自动跟进，让销售立刻减负。',
    18,WHITE,False,spacing=1.35)
pill(s,0.9,4.15,3.5,0.6,'第一步 · 装专家包试跑',CYAN,BG2,13)
pill(s,4.7,4.15,3.5,0.6,'第二步 · 4 周跑通自动闭环',AMBER,BG2,13)
pill(s,8.5,4.15,3.5,0.6,'第三步 · 铺方法论与预警',GREEN,BG2,13)
txt(s,0.9,5.45,11.5,1.2,
    'AI 原生销售管理助手 —— 不是把销售搬上线，而是让销售管理成为增长引擎。',
    18,AMBER,True)

# ---------- 保存 ----------
out = 'AI原生销售管理平台介绍_2026.pptx'
try:
    prs.save(out)
    print('SAVED_OK', out, 'slides=', len(prs.slides._sldIdLst))
except PermissionError:
    out2 = 'AI原生销售管理平台介绍_2026_tmp.pptx'
    prs.save(out2)
    print('LOCKED_SAVED_AS', out2, 'slides=', len(prs.slides._sldIdLst))