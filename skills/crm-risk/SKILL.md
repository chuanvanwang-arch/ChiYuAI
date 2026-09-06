---
name: crm-risk
description: CRM 链断裂/异常检测技能——商机→技术方案>30天无方案 / 赢单前无方案 / 回款逾期 / 阶段只进不退异常。常驻探测（scheduler 周期扫描）+ 主动预警（SSE 推送），先于提问发现风险。只读+告警，不执行写。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# crm-risk · 链断裂/异常检测技能

> 定位：CRM 智能体包的「先于提问的预警」能力（§6.13.8 原则⑤）——不等用户问，主动探测商机链/回款链的断裂与异常，SSE 推送预警。
> 设计输入：总体设计 §6.13 + §3.10（五类告警）+ 决策事件主轴 §6（探测结果入决策网络）。

## 检测规则（内置链断裂模式）

| 链断裂模式 | 判定条件 | 处置 |
|---|---|---|
| 商机→技术方案>30天 | CRM_DEAL 无 has_technical_proposal 边 且 阶段进入 S2 后 >30 天 | 预警：方案缺口 |
| 赢单前无方案 | 商机 stage=S6 但无技术方案粒子 | 预警：赢单缺方案证据 |
| 回款逾期 | 合同(CRM_CONTRACT) 应收日期 < now - 账期 且无回款记录 | 预警：回款逾期 |
| 阶段异常 | 商机阶段倒退（advance 只进不退被违反）或输单无原因 | 告警：流程违规 |

## 执行路径

1. **常驻探测**：scheduler/riskScanner 周期扫描（30min），全量重算 AI 属性（差异检测写入，不重复写）。
2. **主动预警**：命中链断裂 → `emit('crm-risk-scan', {...})` SSE 推送（前端/智能体消费）。
3. **先于提问**：用户没问，系统先报——「3 条商机缺技术方案已超 30 天」「2 笔回款逾期」。

## 输出（业务语言）

- `{ ok, alerts: [{ type, deal, age_days, severity }], summary: '3 条商机缺方案>30天 / 2 笔回款逾期' }`
- 不暴露内部 scanner 名/Action 名。

## 只读+告警，不写

- 探测只读粒子 + 写告警事件（emit），**不写商机/合同数据**（写需 crm-write 两阶段）。
- 绝对禁删：无 delete 工具。

## Action 读清单（常驻探测数据源 + 敏感读边界）

| Action | 用途 |
|---|---|
| `data-particle-read` | 探测数据源（商机/合同/回款粒子读，判定链断裂） |
| `data-particle-attr-read` | 属性元模型读取（探测规则字段） |
| `crm-field-permission` | 字段级权限校验（探测范围过滤） |
| `crm-account-360` | 客户全景（回款归属判定） |
| `crm-customer-360` | 敏感读：客户全维度（需角色确认） |
| `crm-cross-entity-query` | 敏感读：跨实体链路（商机→技术方案→合同） |
| `crm-finance-receivables` | 敏感读：财务应收（回款逾期判定） |
| `crm-contract-expiring` | 敏感读：合同到期（链断裂预警） |

## Action 写清单（本技能只读+告警，不直接写；回收/处置经 crm-write 两阶段）

| Action | 用途 |
|---|---|
| —（无直接写 Action；探测结果只 emit 预警事件，处置写经 crm-write 两阶段） | 只读+告警，写不直连 |

> 写清单一侧为空属 R5「同名不同侧」纪律：crm-risk 是纯只读+告警技能，链断裂处置（商机回收/方案补写/回款跟进）一律经 crm-write 的两阶段写 Action，本技能绝不跨出只读边界。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。