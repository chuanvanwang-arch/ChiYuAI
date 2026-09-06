# 2026-08-26 设计文档×实现状态盘点（截至 08-26 09:1x）

> 上游输入：08-25/08-26 工作日志 + 设计文档全集 + 代码现状探测（ls/grep/file:line 实证）
> 目的：回答「昨天到今天的所有设计文档，还有哪些没开发完」
> 方法：先证据后结论——每项差距给出 `file:line` 级探测结果；git 仓库为空（沙箱无代码提交），实现状态以 src/ 代码树为准

## 1. 已完成（代码树可实证）

| 设计输入 | 现状证据 |
|---|---|
| 阶段1 底座 MVP（10 Task：粒子/本体/编排/kanban/Action/agentLoop/HTTP/SSE/种子） | `src/particles|ontology|events|kanban|action|agent|skills|http` 全目录存在 |
| 决策事件主轴 D1-D6 | `src/decision/`（decisionRepo/autonomyEngine）+ decision 表 |
| 上下文分层 L1-L4 + 角色权限硬闸 | `src/context/`（roleProfiles/scope/assembler/injector）+ executor 第1.5闸 RBAC |
| 记忆三构件 + 30 天蒸馏 | `src/memory/` + `memory_snapshot` 表 |
| Action 写白名单 + 命名空间 | `src/action/whitelist.js` + WRITE_WHITELIST |
| 门户 NL→Page（受控 Schema + 渲染器） | `src/page/` 六模块 + page.test.js 31/31 |
| 预警/反馈回路 | `src/alerts/` 六模块 + alert.test.js 18/18 |
| 审批流引擎（六层粒子 + 状态机 + 撤回/加签/转交） | `src/approval/`（flow/stateMachine/engine/compensation/rules）+ approval-* 测试 |
| ATTIO 四层承接 T1-T11 | `src/particles/particleModel.js` ATTIO 属性 + `src/particles/interactionIndex.js` + 受控边 |
| 售前角色 + method-presales SKILL | `skills/method-presales/` 8 文件（现实范式） |
| 数据来源 1/3/4（evaluator/timers/connectors）+ 粒子详情页 | `src/aiAttributes/` + `src/scheduler/timers.js` + `src/connectors/` + `src/web/particle-detail.html` |
| 粒子属性元模型（5 项 DDL/纯逻辑/仓库/3 Action/RBAC） | `src/metaAttr/` 四模块 + `crm.meta_attr` 表（schema.sql:279）+ meta-attr-* 5 测试文件 |
| 阶段3 L2C 业务闭环（报价/合同/订单/回款/发票/导入） | `src/sales/` + quote/contract/order/payment/invoice/import-service 测试 |

## 2. 未开发（实证差距）

| # | 设计文档 | 计划 | 差距实证 | 状态 |
|---|---|---|---|---|
| G1 | `docs/2026-08-26-particle-attribute-model-ui-design.md`（08-26 设计稿） | `plans/2026-08-26-particle-attribute-model.md` T1-T7 | **T7 未落地**：`src/web/` 无 meta-attr-drawer.html；`/api/meta-attr` 路由未见（routes.js 需确认）；受控组件 attr-field 未建 | 7 Task 已完成 6（DDL/模型/仓库/Action/RBAC 已实证），**仅剩 UI 抽屉层** |
| G2 | `docs/2026-08-26-mcp-pack-complete-plan.md`（对外分发四阶段） | `plans/2026-08-26-mcp-pack-implementation.md` T1-T9 | **T3/T4/T5/T6/T7/T8 未落地**：`src/mcp/` 不存在；package.json 无 `@modelcontextprotocol/sdk`；tool 注册/网关/凭证 全缺；`skills/` 仅 method-presales（缺 7 方法论 + 4 智能体 SKILL）；`agents/` 与 `.workbuddy-plugin/` 目录不存在 | **四阶段全部未实施**（阶段1 方法论 SKILL 也只做了 1/7） |
| G3 | `docs/superpowers/specs/2026-08-26-observability-risk-scan-design.md`（已批准） | （无独立计划文件） | **三处静默吞错未修复**：`decisionRepo.js:75` `.catch(()=>{})` 先例写失败、`:82` 记忆沉淀失败；`timers.js:21` 蒸馏 `.catch(()=>{})`；`:26-28` crm-risk 扫描仍是**空占位**（无 runRiskScan 调用）；`ruleEngine.js:18` lost_requires_reason 仍恒 `{ok:false}`；`monitorStore.js` 无 `failsByKind/recordFailure` | **全部未实现**（R1/R1b/R2/R3 四风险点原样） |

## 3. 结论

还剩 **3 条主线未开发**：

1. **粒子属性元模型 UI 抽屉**（G1，收尾项）——后端 6 Task 全完成，缺 T7 配置抽屉 UI + `/api/meta-attr` 桥接 + attr-field 受控组件。
2. **MCP 对外分发四阶段**（G2，最大缺口）——当前只有 method-presales 一个方法论 SKILL；7 方法论（BANT/MEDDICC/机会矩阵/角色地图/风险权衡/止损点/事实vs话术）+ 4 智能体 SKILL（crm-native/query/write/risk）+ MCP Server（src/mcp 五模块）+ plugin.json 打包 + agents/crm-native.md 全部未做。
3. **可观测化 + crm-risk 真扫描**（G3）——3 处静默吞错加监控计数、ruleEngine lost 规则委托、riskScanner 真扫描定时接线，全部未动。

**依赖顺序**：G1 可独立收尾；G2 的 T3 需先装 MCP SDK（项目级 .npm-cache），T1/T2 方法论 SKILL 可先做；G3 可独立实施（小改动、高风险点精准修复）。

**验收环境提醒**：全量 vitest 需用户本机 PG@5433（沙箱 ECONNREFUSED）；纯逻辑测试可在沙箱跑。