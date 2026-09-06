---
name: method-bant
description: BANT 预算-权限-需求-时间线销售资质方法论——四维逐项评估商机资质（Budget/Authority/Need/Timeline），门控商机是否值得推进，缺任一硬维度禁止升级阶段。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-bant · BANT 销售资质方法论

> 定位：销售（sales）判断"这个商机值不值得现在投入推进"时参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；评估流程见 `core/evaluate.md`；评分门控见 `rules/scoring.md`；维度释义见 `references/dimensions.md`；销售视角见 `profiles/sales.md`。

## 适用场景（调用即自然语言）

- "用 BANT 评估这个商机的资质"
- "这个线索/商机现在该投入还是搁置？"
- 商机进入 `opportunity` 阶段前的资质检查（线索→商机转段）

## 评估流程（四步）

1. 逐维收集：B（预算）→ A（决策权限）→ N（需求）→ T（时间线）
2. 逐维打分：≤0.5 未满足 / ~0.7 部分满足 / ≥0.85 明确满足
3. 计算就绪度：加权平均（各维权重见 `methodology.json`）
4. 门控判定：任一硬维度 <0.6 → 禁止推进（先补缺口，勿空耗）

## 维度快查

| 维 | 含义 | 关键问题 |
|---|---|---|
| B | 预算 Budget | 客户有无明确预算额？在哪条预算线内？ |
| A | 权限 Authority | 我们接触的是决策人还是使用者？决策链多长？ |
| N | 需求 Need | 痛点是否真实紧迫？有无替代方案在竞争？ |
| T | 时间线 Timeline | 客户计划什么时候买？有无明确时间窗？ |

## 角色视角

- sales：快速判断商机优先级与下一步动作（本目录 `profiles/sales.md`）
- manager：团队商机池的整体资质分布与投入分配（`profiles/manager.md`）

## 与既有机制衔接

- 输出与 `crm-deal-advance`（商机阶段推进决策）一致——BANT 未过闸禁止 `advance`
- 四维评分可作 `decision_scenario` 的 `eval_dimensions` 输入（OPP_QUALIFY 闸门条件）

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。