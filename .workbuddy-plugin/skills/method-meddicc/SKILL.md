---
name: method-meddicc
description: MEDDICC 复杂商机赢单方法论——七维校验（指标/经济买家/决策标准/决策流程/识破痛苦/冠军/竞争），评估赢单概率，任一硬维度缺失禁止乐观推进。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-meddicc · MEDDICC 复杂商机赢单方法论

> 定位：销售/销售经理在做**复杂商机（多决策人、长周期、大金额）**赢单判断时参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；评估流程见 `core/evaluate.md`；评分门控见 `rules/scoring.md`；维度释义见 `references/dimensions.md`；角色视角见 `profiles/sales.md`、`profiles/manager.md`。

## 适用场景（调用即自然语言）

- "用 MEDDICC 评估这个复杂商机的赢单把握"
- "这个单子决策人是谁、流程走哪了？"
- 大金额/长周期商机的赢单概率判断（相对 BANT 更重决策链与流程）

## 评估流程（五步）

1. 逐维收集：M（指标）→ E（经济买家）→ D（决策标准）→ D（决策流程）→ I（识破痛苦）→ C（冠军）→ C（竞争）
2. 逐维打分：≤0.5 未满足 / ~0.7 部分满足 / ≥0.85 明确满足
3. 计算赢单就绪度：加权平均（各维权重见 `methodology.json`）
4. 门控判定：任一硬维度 <0.6 → 禁止乐观推进（先补决策链与流程证据）
5. 产出结论：`{ verdict, ready, gaps[], gate }`，gate ∈ `WIN_CONFIDENT | BLOCKED_EB | BLOCKED_CRITERIA | BLOCKED_PROCESS | BLOCKED_PAIN | ...`

## 维度快查

| 维 | 含义 | 关键问题 |
|---|---|---|
| M1 | 指标 Metrics | 客户有可量化的成功指标与基线吗？ |
| E1 | 经济买家 Economic Buyer | 掌握预算审批的人我们触达了吗？ |
| D1 | 决策标准 Decision Criteria | 客户按什么标准选型？我们覆盖几条？ |
| D2 | 决策流程 Decision Process | RFI/RFP/POC/招标走几步？谁参与？ |
| I1 | 识破痛苦 Identify Pain | 痛点真实可陈述且有量化影响吗？ |
| C1 | 冠军 Champion | 内部支持者能否影响决策、提供情报？ |
| C2 | 竞争 Competition | 竞品格局如何，我们位置领先/并列/落后？ |

## 角色视角

- sales：单条复杂商机的短板与下一步动作（`profiles/sales.md`）
- manager：复杂商机池的赢单概率分布与资源倾斜（`profiles/manager.md`）

## 与既有机制衔接

- 输出与 `crm-deal-advance` / 报价推进决策一致——MEDDICC 硬维度未过闸禁止乐观推进报价
- 七维评分可作 `decision_scenario` 的 `eval_dimensions` 输入（赢单判断闸门条件）

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。