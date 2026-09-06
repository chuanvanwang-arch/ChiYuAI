---
name: crm-query
description: CRM 跨模块推理查询技能——粒子图检索（AGE 多跳/pgvector 语义/决策网络先例）、跨模块聚合（商机/客户/回款一句话查询返回结构化结果）。只读直连默认放行，不触发写闸。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# crm-query · 跨模块推理查询技能

> 定位：CRM 智能体包的「查」能力——把「这个商机什么情况 / 客户360 / 本月回款」等一句话，翻译成 粒子图检索 + 多跳 + 语义 + 决策先例 的结构化返回。
> 设计输入：总体设计 §6.13（跨模块推理查询）+ §6.3（决策网络）+ L1-L4 上下文分层。

## 查询能力矩阵

| 用户一句话 | 检索通道 | 返回 |
|---|---|---|
| "这个商机什么情况" | 粒子图：CRM_DEAL 节点 + 出边（客户/产品/方案/报价） | 商机详情 + 关联实体 + 阶段/赢率 |
| "客户360" | CRM_ACCOUNT 节点 + 边（联系人/商机/合同/回款） | 客户全貌（人/单/款） |
| "本月回款多少" | 回款粒子聚合（payment） | 金额/逾期/账期分布 |
| "为什么这个决策这么定" | 决策网络：decision → REFERENCED_PRECEDENT 多跳 | 决策链路（先例引用来源） |
| "语义搜：和XX相似的商机" | pgvector 相似度（embedding 写时构建） | top-N 相似粒子 |

## 只读直连（默认放行）

- 查询不触发写闸：直接走 `data-particle-read`（读直连） + 聚合。
- 无凭证/未知凭证：降级 sales（只读能力保留；写不在此技能）。

## 绝对禁删

- 本技能只读：无 delete/remove 工具；若用户意图删除 → 拒绝并说明（安全红线）。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。