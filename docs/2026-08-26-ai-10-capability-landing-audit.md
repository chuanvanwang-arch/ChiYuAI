# 2026-08-26 十能力落地审计（10 份 ai-* 设计文档 vs src/ 代码）

> 方法：以 src/ 代码为准（grep 证据 + 文件:line 探针），逐一对照 `docs/2026-08-25-0X-ai-*.md` 各文档「验收判据/实现状态」章节。
> 判定级：**✅ 已落地**（代码证据齐全且接线有调用点）／ **✅⚠ 已落地但与文档描述有偏差**（代码在，形态/接线与文档措辞不一致）／ **⭕ 部分落地**（机制在，端点/数据未闭环）／ **❌ 未落地**（设计存在，代码无对应）。
> 注：本文档与 `2026-08-26-implementation-status-audit.md` 互为补充 —— 彼为「四问全域实测」，本文为「十能力逐文档对照」。

## 总判定表

| # | 能力文档 | 核心判据（文档 §5 验收） | src/ 代码证据 | 判定 |
|---|---|---|---|---|
| 01 | ai-particle-system-design | 9 真粒子 C0-C4 收敛 · 19 属性类型 · 16 受控谓词 · why 载体 | `particles/particleModel.js:6/12/29/43/49/59/64/70/75`（9 粒子）；`:58-69` 19 类型+16 谓词；`transitionedBecause` `:218`；`ontology/hooks.js:131-133` 三钩子 | **✅ 已落地**（§9 自检 [ ] 项 AGE 未用、动态元模型未实现 → 已被 `ageSync` + `metaAttr` 后续补齐） |
| 02 | ai-ontology-vector-build | 写时三钩子（ensureEmbedding/ensureTsVector/ontologySync）· 向量 384 | `ontology/hooks.js:131-133`、`embedding.js:5`（DIM=384）、`db/schema.sql:19` vector(384)、`ageSync.js:1`（写时镜像 AGE） | **✅ 已落地**（§6 自检 [ ] 项 AGE 未用 → 已由 `ageSync.js`/`enable-age.sql` 补齐；覆盖率监控/backfill 仍为阶段 2） |
| 03 | ai-multi-agent-orchestration | 四态状态机 · failure_limit=3 熔断 · maxInflight 并发 · 3 Agent 装配 | `kanban/kanban.js:36/42/46/51/63/73/81/91`（ready→running→done/failed→blocked）、`dispatch.js:6/11`（maxInflight=3）、`agentSpec.js`（3 Agent 六段式）、`agentLoop.js` | **✅ 已落地**（§7 全 [x]） |
| 04 | ai-context-layering | L1-L4 累积注入 · 五角色七要素 L4 实例 · 降级链 fail-open | `context/assembler.js:97-106`（L1-L4 四级装配+超时降级）、`injector.js:3-18`（L1/L2/L3 组装）、`roleProfiles.js:16`（exec 七要素）；`context.test.js` | **✅ 已落地**（文档标注「阶段 2 启动」——实际已实现于 src/context/） |
| 05 | ai-memory-lifecycle | 记忆三构件（memory_log append-only / memory_note curated / memory_snapshot 不可变）· 30 天蒸馏 · 防污染 | `memory/memoryLog.js:26/33/40/48-50`、`note.js:6-8`（upsert+archived）、`snapshot.js:6`（禁 update/delete）；`db/schema.sql:197/239/249` | **✅ 已落地**（§5 判据 [ ] 均已有代码；蒸馏任务 `timers.js:23` 每日跑） |
| 06 | ai-native-action-design | 11 crm-* SKILL Action 表面 · 三闸写通道 · D6 禁删机制化 | `seed-actions.js:265-336`（quote/contract 写链，confirm + needsApproval 三闸）、`executor.js:78`（approvalPassed 第三闸）、`registry.js:51`（detectCrudExplosion 红线）、`whitelist.js` | **✅ 已落地**（§5 判据 [ ] 大多已代码化；四审批域 4/4 收口见 approval/） |
| 07 | ai-event-driven-evolution | 7 类预警事件全集 · 事件总线 · 审批回滚补偿 · 无定时扫描 | `events/sse.js`（5 事件域 task/trace/approval/particle/payment）、`alertRegistry.js:24`（forecast_breach 等）、`approval/compensation.js:1-24`（写前快照+回滚）、`scheduler/riskScanner.js` + `timers.js:31-38` | **✅⚠ 部分落地**：事件域+补偿已落地；但 07 §5-2 明确「**无定时任务式预警**（D4）」，代码 `timers.js` 存在 30min 定时 `runRiskScan`（riskScanner）与 lead 池回收扫描（仅发射事件、不直接写，属组织治理规则驱动）——**与文档措辞相悖，需文档修订或代码改造** |
| 08 | ai-portal-page-generation | NL→Schema→渲染三段式 · 三层护栏（guardNlInput/validatePageSchema/renderPage）· 4 粒子校验 · 待办四视角 · 13 场景 | `page/guardrails.js:15`、`pageStore.js:15-27`（guard→validate→render）、`validator.js:12`、`renderer.js:154`、`page/schema.js`、`pages/S01/S02/S13-15/S25 schema`（13 场景页型）；`web/portal-stage3-mockup.html` 原型 | **✅⚠ 已落地但门户收敛待补**：三段式+护栏+13 场景页型落地；待办四视角（待我审批/我处理/我发起/抄送我的）与「渲染器=配置/AI 共用」尚未见独立页面产物（`pages/` 为 schema 注册非成品页），监控台三指标在 `sales-decision-monitor.html` 有雏形——**待办工作台四视角为首版门户待补项** |
| 09 | ai-feedback-loop | V1 对账触发催收 Action · V2 预测偏差回灌 · V4 KPI 三级预警 · V5 evaluator · V6 token-业务对账 · V8 回写 | `alerts/feedbackMetrics.js`（per-tier 自主率/升级率/推翻率/时延）、`aiAttributes/evaluator.js:7/31`（revenue_forecast 兜底）、`alertRegistry.js`（forecast_breach）、`scheduler/riskScanner.js`（差异检测） | **✅⚠ 部分落地**：per-tier 指标与预测预警落地；**V6 token-业务因果对账** 与 **V2 偏差回灌预测模型（close_accuracy/retune_forecast）** 在 src/ 中无独立模块（token 成本无采集）——属阶段 3 待补 |
| 10 | ai-capability-audit | V1 10 能力矩阵无空白 · V2 12 域全进审计 · V3 价格/审批记录=审计事件流 · V5 写钩子必经节点 · V7 防篡改链 | `decision/provenance.js:10-22`（decision_provenance append-only + SHA-256 链）、`:37-41`（shaChain）、`:61-73`（verifyChain TAMPERED 检测）、`db/schema.sql`（task_audit）+ `kanban.js:9-11`；`decision/conflict.js` | **✅⚠ 部分落地**：**防篡改链（V7）已完整落地**；但 V5「审计写钩子=粒子写通道单点必经」**未落地**——src 无独立 `auditHook`/`audit_event` 表，审计分散在 decision_provenance/task_audit/approval 三个具体域（机制级必经节点未形成），V2 12 业务域全覆盖（LEAD→ORDER）**未闭环** |

---

## 证据明细与缺口分级

### ✅ 已落地（5/10）：01 粒子系统 · 02 本体向量 · 03 编排 · 04 上下文分层 · 05 记忆生命周期
- 01/02/03/04/05 的文档 §9/§7/§6「实现状态」标注（阶段 1 部分未落地：AGE 未用、动态元模型未实现、覆盖率监控/backfill 未做）**已被后续代码补齐**：
  - AGE 未用 → 已有 `src/ontology/ageSync.js`（写时镜像 AGE 只读查询面）+ `db/enable-age.sql`（幂等启用）；
  - 动态元模型 → 已有 `src/metaAttr/`（metaAttrModel/metaAttrRepo/fieldPermission）；
  - 记忆三构件 → `memory_log`/`memory_note`/`memory_snapshot` 三表 + `judgeWorthiness` + 30 天蒸馏（`timers.js:23` 每日跑）。
- 判定均为 **✅（代码证据链完整）**。

### ✅⚠ 已落地但有偏差（2/10）：07 事件驱动 · 08 门户
- **07**：`timers.js:31-38` 存在 30min 定时 `runRiskScan` 与 lead 池回收扫描 —— 文档 §5-2 明确「无定时任务式预警（D4）」。**判定：扫描仅发射事件、不直接跨粒子写，属组织治理规则驱动，与文档措辞相悖；需文档澄清（事件驱动为主 + 规则治理兜底）或把扫描改造为事件触发。**
- **08**：三段式护栏 + 13 场景 Schema 全落地；但「待办工作台四视角」（待我审批/我处理/我发起/抄送我的）与「配置界面与 AI 生成共用同一渲染器」尚未见独立成品页。`src/pages/` 为 Schema 注册（S01/S02/S13/S14/S15/S25），非成品页面；`web/portal-stage3-mockup.html` 为原型。**判定：机制已备，首版门户成品页待补。**

### ⭕ 部分落地（3/10）：06 部分 · 09 部分 · 10 部分
- **06**：Action 表面（quote/contract/invoice/order 四写域）+ 三闸写通道 + 禁删机制化（detectCrudExplosion 红线）已落地；但 11 个 crm-* SKILL 全部明细化为 Action 表面尚未收口（部分 SKILL 仍只有读清单一侧）。
- **09**：per-tier 指标（自主率/升级率/时延）与预测预警已落地；**V6 token-业务因果对账** 与 **V2 偏差回灌预测模型（close_accuracy/retune_forecast）** 无独立模块 —— token 成本未采集、预测模型未回灌，属阶段 3 待补。
- **10**：防篡改链（V7）完整；**V5 审计写钩子=粒子写通道单点必经** 未形成（审计分散在 decision_provenance/task_audit/approval 三个具体域，非机制级必经节点）；V2 12 业务域全覆盖未闭环。

### ❌ 未落地（0/10）
- 无「文档有设计、代码零对应」的能力 —— 10 份均有对应代码支撑（全部至少部分落地）。

---

## 缺口总表（按优先级）

| P | 缺口 | 对应能力 | 证据 | 建议 |
|---|---|---|---|---|
| P0 | **全部未提交改动（丢失风险）**：`git status` 显示 12+ M + 25+ untracked（`src/pages/`、`src/sevenDimensions/`、`src/http/configRouter.js`、`src/page/permissionComposer.js`、`test/sevenDimensions/`、`tmp/*.mjs` 等） | 全局 | `git status --short` | **用户本地立即提交**（分笔：AGE 程序 / skills-registry 修复 / G1/G2/G3 收尾） |
| P1 | **07 定时扫描与文档措辞相悖**：30min `runRiskScan`/lead 池回收 vs §5-2「无定时任务式预警」 | 07 | `timers.js:31-38` | 走 brainstorming 定：文档修订（事件驱动+规则治理兜底）或改造为事件触发 |
| P1 | **10 V5 审计单点必经未形成**：无独立 auditHook/audit_event 表 | 10 | `grep auditHook` 零命中 | 阶段 3 收口：在粒子写通道挂单点审计钩子（对齐 10 §3.2） |
| P2 | **09 V6 token-业务对账未落地**：无 token 成本采集/对账模块 | 09 | `grep tokensConsumed` 零命中 | 阶段 3 补：evaluator 输出接入 token 计量 → 业务产出对账 |
| P2 | **08 待办工作台四视角成品页未产出** | 08 | `src/pages/` 为 schema 注册 | 首版门户补 4 视角登录页（复用渲染器） |
| P2 | **06 11 SKILL Action 明细未全收口** | 06 | 部分 SKILL 仅读清单一侧 | 逐个 SKILL 补写清单一侧（R5 同名不同侧） |

---

## 结论

**10 份 ai-* 设计文档：01/02/03/04/05 已全部落地；07/08 已落地但存在 2 处与文档描述的偏差；06/09/10 部分落地（3 处机制级缺口）；无完全未落地项。** 主体设计 → 代码的转化率约 8/10「已落地或基本落地」，2-3 处属阶段 3 收口债（审计单点钩子、token 对账、待办四视角成品页）+ 1 处文档/代码措辞相悖（07 定时扫描）。

**⚠️ 最紧急动作**：`git status` 显示 12+ M + 25+ untracked **全部未提交**（含 AGE 决策网络/MCP/门户 schema/七维度/角色确认权限等 8-23 新增模块），丢失风险最高——请本地立即按上述分笔提交。