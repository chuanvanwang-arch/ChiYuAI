---
name: method-opportunity-matrix
description: 机会矩阵方法论（商业价值×可行性×竞争定位）——优先排序商机/机会组合，高价值高可行优先投入，低价值低可行暂缓或淘汰。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-opportunity-matrix · 机会矩阵方法论

> 定位：销售/销售经理在**机会组合排序**（多条商机/机会先做哪条）时参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；评估流程见 `core/evaluate.md`；评分门控见 `rules/scoring.md`；维度释义见 `references/dimensions.md`；角色视角见 `profiles/sales.md`、`profiles/manager.md`。

## 适用场景（调用即自然语言）

- "这么多商机，先集中打哪几条？"
- "帮我把管线按价值×可行性排个序"
- 机会/商机组合的优先级排序与资源分配（相对 BANT 单条资质、MEDDICC 单条赢单，这是组合视角）

## 评估流程（四步）

1. 逐维评估：V1（商业价值）→ F1（可行性）→ P1（竞争定位）
2. 将每条商机放入 2×2 象限：价值（纵）× 可行性（横）
3. 排序规则：高价值×高可行 = 主攻；高价值×低可行 = 培育（补可行性）；低价值×高可行 = 收割（低成本拿下）；低价值×低可行 = 暂缓/淘汰
4. 产出结论：`{ verdict, quadrant, rank, gaps[], gate }`，gate ∈ `PRIMARY | NURTURE | HARVEST | PARK`

## 维度快查

| 维 | 含义 | 关键问题 |
|---|---|---|
| V1 | 商业价值 Business Value | 金额大小、战略意义、可复制性？ |
| F1 | 可行性 Feasibility | 决策链/预算/产品匹配度是否齐备？ |
| P1 | 竞争定位 Competitive Position | 相对竞品领先/并列/落后？ |

## 角色视角

- sales：单条商机属于哪个象限、下一步动作（`profiles/sales.md`）
- manager：组合的象限分布与资源投入强度（`profiles/manager.md`）

## 与既有机制衔接

- 输出与 `crm-deal-advance` / 管线优先级一致——主攻象限商机优先推进，PARK 象限暂停投入不推进
- 象限评分可作 `decision_scenario` 的 `eval_dimensions` 输入（资源分配闸门条件）

## Action 读清单（评估数据源）

| Action | 用途 |
|---|---|
| `data-particle-read` | 读取商机/客户粒子（评估输入） |
| `data-particle-attr-read` | 属性元模型（方法论维度字段映射） |
| `crm-field-permission` | 字段级权限校验（评估范围过滤） |
| `crm-account-360` | 客户全景（背景/决策链佐证） |
| `crm-customer-360` | 敏感读：客户全维度（需角色确认） |

## Action 写清单（联动结果写回，经 crm-write 两阶段）

| Action | 用途 |
|---|---|
| `crm-deal-advance` | 主攻象限商机优先推进；PARK 暂停投入 |
| `data-particle-update` | 矩阵坐标写回商机（value/win_prob/competitive_position） |

> 写清单一侧为「方法论结果 → 业务写」联动面：本 method SKILL 不直接 dispatch 写 Action，一律经 crm-write 两阶段（第0闸 + action-confirm）执行。PARK 象限不推进（暂停投入，不消耗资源）。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。