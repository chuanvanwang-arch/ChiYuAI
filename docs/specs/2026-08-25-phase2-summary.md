# 阶段 2 验收汇总 · AI 原生销售管理平台（CRM-ai-native 认知+智能体层）

> 日期：2026-08-25（晚）｜状态：**5/5 子系统全部完成**
> 上游：`docs/specs/2026-08-25-ai-native-crm-overall-design.md` §8.6（阶段 2 接线清单）
> 纪律：每 Task 一 commit；TDD；纯逻辑本地全绿（无 PG 依赖）；DB 集成留 PG 环境验收

---

## §1 总览（5 子系统 × 交付物）

| # | 子系统 | 方法论 | 设计文档（全部已批准） | 实施 commit 区间 | 纯逻辑测试 |
|---|---|---|---|---|---|
| ① | 上下文分层 L1-L4 | ai-context-layering | `docs/specs/2026-08-25-context-layering-design.md` | `c9f83fc`→`a7afe9c` | 20/20 ✅ |
| ② | 记忆三构件 | ai-memory-lifecycle | `docs/specs/2026-08-25-memory-lifecycle-design.md` | `01923f3`→`b22bafa` | 21/21 ✅ |
| ③ | Action 写白名单+命名空间 | ai-native-action-design | `docs/specs/2026-08-25-action-whitelist-design.md` | `9f0fd25`→`3f66110` | 14/14 ✅ |
| ④ | 门户生成 NL→Page | ai-portal-page-generation | `docs/specs/2026-08-25-portal-page-generation-design.md` | `8f61989`→`229fa6a` | 31/31 ✅ |
| ⑤ | 预警/反馈回路 | ai-event-driven-evolution / ai-feedback-loop | `docs/specs/2026-08-25-alert-feedback-loop-design.md` | `6336863`→`93d18be` | 18/18 ✅ |

**合计：104 例纯逻辑测试本地全绿**（`node node_modules/vitest/vitest.mjs run test/*.test.js`，实测 2026-08-25 晚）。

---

## §2 各子系统落地证据（代码锚点）

### ① 上下文分层 L1-L4（`src/context/`）
- `role_context_profile` 表 + 5 角色七要素种子；`roleProfiles.js`/`scope.js`/`assembler.js`/`injector.js`。
- executor 第 1 闸 `scope_violation`（写前范围校验）+ agentLoop `buildContextBlock` L1→L4 注入，检索降级链永不崩。

### ② 记忆三构件（`src/memory/`）
- judge（四优先级闸门：凭证/显式/噪声/视界）、memoryLog（layer/event_type/distilled/archived/ttl_days）、snapshot（不可变）、note（L-User upsert）、capture（事件总线单汇点，跳过 decision 域）。
- appendMemory 唯一汇点（decisionRepo 委托重构消除双写）；distillMemory 标蒸馏（30 天，2×ttl 归档）；retrieveMemory 按层/主题选通道。

### ③ Action 写白名单+命名空间（`src/action/`）
- registry 横切属性（namespace/agentTool/needsApproval/force/version/owner/parameters+candidateSource）+ 命名空间分层（crm/data）+ `detectCrudExplosion` 反爆炸护栏 + `resetRegistry`。
- whitelist：对话式写白名单（crm-deal-advance/data-particle-create/data-particle-update）+ blast-radius（autonomous/human_gate）。
- executor 第 2 闸：force 双闸（needs_force）+ 写白名单闸（write_whitelist）+ RBAC 第 1.5 闸；resolver 能力清单（agents.md 风格 markdown）。

### ④ 门户生成 NL→Page（`src/page/`）
- 三段式：NL→受控 Schema（`schema.js` 协议常量 + `nlParser.js` 确定性解析，禁直出 HTML）→渲染器（`renderer.js` 唯一渲染出口）。
- 三层护栏：`guardrails.js` 输入层（拦截 script/javascript:/on*/eval/iframe/img·svg 事件）→ `validator.js` 结构层 4 粒子护栏（粒子值域旧值直接拒/状态字段 filter 仅 eq 不可聚合/存量快照仅 latest/Action 白名单）→ 渲染层（校验+escapeHtml 转义+四态 loading/empty/error/partial+data-action 声明式+输出后无 `<script>` 强检）。
- `pageStore.js` 生命周期 draft→publish→revert（内存 Map，注入拒绝不落库，重复 publish 幂等）+ routes 4 端点。
- **语义修正**：存量快照字段仅 `CRM_PRODUCT.qty/price`（`CRM_DEAL.amount` 归流式指标可 sum，非快照）。

### ⑤ 预警/反馈回路（`src/alerts/`）
- 5 类业务告警规则表：deal_stuck/lead_overdue/forecast_breach/approval_bottleneck/payment_due（payment_due 因 CRM_INVOICE 粒子未落地默认停用）。
- 规则后台启停（`setRuleEnabled`）+ 处置状态机 open→ack→close（close 必填 reason，幂等拒绝）。
- per-tier 反馈指标纯函数：自主率/升级率/推翻率/平均决策时延（`feedbackMetrics.js`）。
- 写时触发接线：particle 域事件→规则判定→createAlert→SSE alert 域转播（不阻塞主事务，未启用规则不告警，退订生效）。
- 端点模块化（`alertEndpoints.js` 权威路径清单+处理器组装，并发隔离不碰 routes.js）。

---

## §3 验收判据对照

| 判据 | 结果 | 证据 |
|---|---|---|
| 每 Task 一 commit | ✅ | 各子系统 commit 区间（§1 表） |
| 纯逻辑本地全绿 | ✅ | 104/104（§1 表实测） |
| 设计先行（brainstorming→设计→批准→计划→实现） | ✅ | 5 份设计文档均「已批准」（§1 表） |
| DB 集成留 PG 验收 | ⏳ | `crm.alert`/`crm.alert_rule`/`role_context_profile` 等表 + DB 读写留 PG 环境（阶段 3） |

---

## §4 已知事项与边界

- **并发会话**：本项目存在多会话并发推进（routes.js 等被并发整合会话持续改写；alert 命名 alertStore/alertEndpoints 含 s 已收敛）。提交一律用 **pathspec 限定**（`git commit -- <文件>`），严禁 `git add -A`（本日两次误带并发未跟踪文件的教训）。
- **DB 集成部分**：context 20/20、memory 21/21 为本地全绿实测（含 DB 相关用例的本地可测部分），完整 DB 集成验收仍建议 PG 环境跑 `node db/migrate.js --seed` 后全量复跑确认。
- **阶段 2 收口无新增 ai-* 能力序号**：全部落地对齐既有 10 大能力基线，符合用户级铁律（清单不可新增/删除/重编号）。

---

## §5 下一步（阶段 3 建议）

1. **业务闭环增量**：线索→客户→商机→报价→合同→订单→回款，每 Task 一 commit。
2. **DB 集成验收**：PG 环境 `node db/migrate.js --seed` + 全量子系统测试复跑。
3. **决策主轴深化**：§6 决策事件主轴既有 D1-D5 已完成；§6.13 引擎晶格/角色自适应落地（阶段 3 候选）。