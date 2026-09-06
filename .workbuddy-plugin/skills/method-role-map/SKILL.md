---
name: method-role-map
description: 客户角色地图方法论——识别决策链/影响者/使用者/利益相关方四类角色，绘制决策链拓扑，标注支持/中立/反对立场，门控售前方案的推动路径。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-role-map · 客户角色地图方法论

> 定位：售前（presales）/销售（sales）在**多决策人复杂采购**中，需要看清"谁在拍板、谁在用、谁在反对"时参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；评估流程见 `core/evaluate.md`；评分门控见 `rules/scoring.md`；维度释义见 `references/dimensions.md`；角色视角见 `profiles/presales.md`、`profiles/sales.md`。

## 适用场景（调用即自然语言）

- "画一下这个客户的决策链"
- "这个单子的反对者是谁？支持者是谁？"
- 复杂采购前的决策链拓扑梳理（对齐 MEDDICC 的 E1/D2——角色地图是其更细化的执行工具）

## 评估流程（五步）

1. 逐类识别：决策者（D）→ 影响者（I）→ 使用者（U）→ 利益相关方（S）
2. 绘制拓扑：谁找谁、谁审批谁（决策链拓扑）
3. 标注立场：对方案的 支持/中立/反对 立场
4. 找出关键路径：必须打通的支持者/必须转化的反对者
5. 产出结论：`{ verdict, topology[], stance[], gate }`，gate ∈ `PATH_CLEAR | BLOCKED_DECISION | BLOCKED_OBJECTOR | UNKNOWN_TOPOLOGY`

## 维度快查

| 维 | 含义 | 关键问题 |
|---|---|---|
| D | 决策者 Decision Maker | 最终拍板人是谁？有几人？ |
| I | 影响者 Influencer | 谁的意见影响决策（技术/财务/法务）？ |
| U | 使用者 User | 谁每天用系统？他们的痛点谁代言？ |
| S | 利益相关方 Stakeholder | 谁会被方案影响（合规/运维/采购）？ |

## 角色视角

- presales：售前方案推动路径——支持者代言、反对者转化（`profiles/presales.md`）
- sales：决策链触达顺序与 Champion 培养（`profiles/sales.md`）

## 与既有机制衔接

- 输出与 `crm-deal-advance` 推进闸一致——决策链未打通（BLOCKED_DECISION）禁止乐观推进
- 角色立场可作 `decision_scenario` 的 `eval_dimensions` 输入（复杂商机赢单评估条件）

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。