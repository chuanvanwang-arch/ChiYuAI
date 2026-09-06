---
name: crm-native
description: CRM 智能体包编排入口——意图路由 → 技能分发（crm-query/crm-write/crm-risk + 7 个 method-* 方法论子技能），惰性编排（用到哪引擎加载哪引擎），角色自适应（5 角色不问你是谁）。零信任：只读直连、写两阶段、绝对禁删。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# crm-native · CRM 智能体包编排入口

> 定位：任意办公智能体（WorkBuddy/其他 Agent）挂载本 SKILL 后，获得「AI 原生 CRM」的对话式能力——一句话查商机、一句话写入（两阶段）、链断裂预警。
> 设计输入：总体设计 §6.13（对话式 CRM 智能体包）+ §6.13.8 设计原则六条。

## 意图路由（一句话 → 技能分发）

| 用户自然语言意图 | 分发技能 |
|---|---|
| "这个商机什么情况/帮我查下客户360" | `crm-query`（跨模块推理查询） |
| "记一条：XX客户新增商机 YY 百万" | `crm-write`（两阶段写入，第0闸） |
| "最近有没有链断裂/哪些商机要预警" | `crm-risk`（常驻主动探测） |
| "这个决策为什么这么定/它的影响地图/这个实体的关系网" | `crm-query` → **graph_query**（决策图只读查询面 `/api/graph/*`） |
| "用 BANT 评一下这个商机/机会矩阵排个序" | `method-bant`/`method-opportunity-matrix` 等 7 个 method-* |

## 角色自适应（不问你是谁，自推断）

- 从对话内容推断角色（销售提商机/经理看组合/售前出方案/高管看止损/财务看回款），加载对应 profiles。
- 不索身份：无凭证/凭证未知 → 最小权限降级 `sales`（只读直连；写需两阶段确认）。

## 惰性编排（用到才加载）

- 不预载全部引擎：按意图路由只加载目标技能与其依赖（九引擎各司其职）。
- 一次对话可能串联多技能：查 → 评估 → 写入，按需依次加载。

## 安全红线（继承总则）

- 只读直连放行；写必须两阶段（phase1 取表单 → phase2 confirm_token 执行）+ decision_id（第0闸）。
- 绝对禁删：无 delete/remove 工具；凭证隔离：客户端 token 只映射 actor，不直达 Action ctx。

## 决策图查询（graph_query · 只读查询面）

> 外部/办公智能体经本能力做「图级只读检索」，统一走 `/api/graph/*` REST 面（与 `/api/monitor/*` 并列）。设计输入：AGE 全面启用 + Semantica 式决策链（计划 P8）。

- **四个端点**（事实源仍在 `crm.particles`/`crm.edges`/`crm.decision` 等表，AGE 作只读镜像查询面，不可用时自动降级回递归 CTE）：
  - `GET /api/graph/neighbors?entityId=` → 实体邻居边 + 解析邻居粒子摘要（实体级关联网络）
  - `GET /api/graph/trace?decisionId=` → 决策因果链（上游=为什么 / 下游=导致了什么）
  - `GET /api/graph/impact?decisionId=` → 决策影响地图（下游全节点 + 深度 + 边）
  - `GET /api/graph/provenance?decision_id=` → 决策 PROV-O 溯源审计（链完整性 + 条目 + 上下游 + 引用先例）
- **纪律（零信任）**：① 只读，绝不写图；② 绝对禁删；③ RBAC 数据范围过滤（`role_context_profile.data_scope` 行级过滤，越权实体返回空）；④ 返回受限范围，不暴露内部 Action/agent 名。
- **实现**：REST 端点位于 `src/http/routes.js`（`/api/graph/*` 段）；可视化看板 `web/decision-graph.html`（路由 `/decision-graph`）消费上述端点。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。