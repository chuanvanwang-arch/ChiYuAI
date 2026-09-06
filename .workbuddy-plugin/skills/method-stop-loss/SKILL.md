---
name: method-stop-loss
description: 止损点方法论（负净值/投入预算/退出门）——为带风险的商机或项目预设止损阈值，投入超过预算即触发退出门检查，防止沉没成本绑架决策。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-stop-loss · 止损点方法论

> 定位：高管（exec）/销售经理（manager）在**高风险、长周期、大投入商机或项目**上，需要预先设定\"什么时候撤\"参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；评估流程见 `core/evaluate.md`；评分门控见 `rules/scoring.md`；维度释义见 `references/dimensions.md`；角色视角见 `profiles/exec.md`、`profiles/manager.md`。

## 适用场景（调用即自然语言）

- "这个单子跟了 6 个月还没动静，该不该撤？"
- "给这个大项目设个止损线，投入上限多少？"
- 高风险长周期商机的止损阈值设定与退出门触发（对齐风险权衡：什么时候该撤）

## 评估流程（五步）

1. 逐维收集：NV（累计投入净值）→ CB（投入预算上限）→ EG（退出门）
2. 计算净值：`净值 = 赢单预期收益现值 - 已投入成本（人力/时间/售前资源）`
3. 对照预算：累计投入是否超过预算上限（`CB`）
4. 触发检查：超过预算/净值转负/关键里程碑连续未达成 → 触发 EG（退出门）
5. 产出结论：`{ verdict, net_value, budget_usage, exit_triggered, gate }`，gate ∈ `CONTINUE | WATCH | EXIT_REQUIRED`

## 维度快查

| 维 | 含义 | 关键问题 |
|---|---|---|
| NV | 净投入净值 Net Value | 已投入成本 vs 赢单预期收益现值，净值转负了吗？ |
| CB | 投入预算上限 Cost Budget | 这个商机/项目预设可投入上限（人/天/金额）是多少？ |
| EG | 退出门 Exit Gate | 什么信号出现就必须撤（预算超支/里程碑未达成/关键人离职）？ |

## 角色视角

- exec：公司级止损纪律——哪些项目该撤、避免沉没成本绑架（`profiles/exec.md`）
- manager：团队商机/项目止损阈值设定与月度触发检查（`profiles/manager.md`）

## 与既有机制衔接

- 输出与 `crm-deal-advance` 推进闸一致——EXIT_REQUIRED 禁止继续推进投入
- 退出门信号可作 `decision_scenario` 的 `eval_dimensions` 条件（止损决策闸门）
- 与 `method-risk-tradeoff` 互补：风险权衡管"要不要进"，止损点管"何时撤"

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。