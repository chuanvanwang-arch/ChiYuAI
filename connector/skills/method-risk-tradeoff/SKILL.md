---
name: method-risk-tradeoff
description: 风险权衡方法论——风险×收益双维评估（风险等级/收益预期/红线/缓解措施），量化商机或决策的风险收益比，触碰红线一票否决，有缓解才可推进。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-risk-tradeoff · 风险权衡方法论

> 定位：销售/销售经理在做**带风险的商机或决策**（大折扣、长账期、新客户、定制开发）时，需要量化"值不值得干"参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；评估流程见 `core/evaluate.md`；评分门控见 `rules/scoring.md`；维度释义见 `references/dimensions.md`；角色视角见 `profiles/sales.md`、`profiles/manager.md`。

## 适用场景（调用即自然语言）

- "这个大折扣单子应不应该接？"
- "这个新客户定制多、风险高，值不值得投入？"
- 带风险商机的风险收益比评估与红线检查（对齐止损点：风险不可控即触发止损视角）

## 评估流程（五步）

1. 逐维收集：R（风险等级）→ B（收益预期）→ RD（红线检查）→ M（缓解措施）
2. 计算风险收益比：`ratio = 收益预期 / (风险等级 × 影响值)`
3. 红线检查：触碰红线（合规/信用/交付能力硬伤）→ 一票否决
4. 缓解评估：有可落地的缓解措施 → 可推进；无缓解 → 暂缓或止损
5. 产出结论：`{ verdict, ratio, redline[], mitigation[], gate }`，gate ∈ `GO | REDLINE_BLOCK | MITIGATION_REQUIRED | STOP_LOSS`

## 维度快查

| 维 | 含义 | 关键问题 |
|---|---|---|
| R | 风险等级 Risk Level | 客户信用/付款/交付/合规风险有多高？ |
| B | 收益预期 Expected Benefit | 金额/利润/战略价值有多大？ |
| RD | 红线 Red Line | 合规/信用/交付能力是否存在硬伤？ |
| M | 缓解措施 Mitigation | 每项风险有无可落地的抵消动作？ |

## 角色视角

- sales：单条商机敢不敢推进、需要什么缓解（`profiles/sales.md`）
- manager：商机组合的风险敞口与红线管控（`profiles/manager.md`）

## 与既有机制衔接

- 输出与 `crm-deal-advance` 推进闸一致——REDLINE_BLOCK 禁止推进；MITIGATION_REQUIRED 需缓解落地
- 风险等级可作 `decision_scenario` 的 `eval_dimensions` 输入（风险决策闸门条件）
- 与 `method-stop-loss` 互补：风险权衡管"要不要进"，止损点管"何时撤"

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
| `crm-deal-advance` | 风险收益比过闸后推进；REDLINE 一票否决 |
| `data-particle-update` | 风险评分/红线标记写回商机 |

> 写清单一侧为「方法论结果 → 业务写」联动面：本 method SKILL 不直接 dispatch 写 Action，一律经 crm-write 两阶段（第0闸 + action-confirm）执行。REDLINE_BLOCK 禁止推进；MITIGATION_REQUIRED 需缓解落地。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。