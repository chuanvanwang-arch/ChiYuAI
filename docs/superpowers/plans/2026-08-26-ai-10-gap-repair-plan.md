# 2026-08-26 十能力缺口修复计划（ai-10-gap-repair）

> 依据：`docs/2026-08-26-ai-10-capability-landing-audit.md` 缺口总表（P1×2 / P2×3）。
> 方法：TDD（先写失败测试 → 实现 → 绿 → commit），每 Task 一 commit。
> 前提：**先执行「Step-0 立即提交」**（当前工作树 12+ M / 25+ untracked 全部未提交，丢失风险最高），再按 Task 顺序修复。

---

## 缺口总表（修复目标）

| # | 缺口 | 来源能力 | 优先级 | 修复策略 |
|---|---|---|---|---|
| G0 | 全部未提交改动（丢失风险） | 全局 | **P0** | 本地分 5 笔提交（见 Step-0） |
| G1 | 10-审计「写钩子=粒子写通道单点必经」未形成（无独立 auditHook/audit_event） | 10-ai-capability-audit | **P1** | 在粒子写通道挂单点审计钩子 + `audit_event` 表（对齐文档 V5） |
| G2 | 07「定时扫描 vs 文档§5-2无定时扫描」相悖 | 07-ai-event-driven-evolution | **P1** | 文档修订（事件驱动为主 + 规则治理兜底）或代码改造——本计划走**文档修订**（扫描仅发事件不直接写，语义不违事件驱动） |
| G3 | 08「待办工作台四视角成品页」未产出 | 08-ai-portal-page-generation | **P2** | 基于既有渲染器 + `src/pages/` schema 注册产出 4 视角成品页 |
| G4 | 09-V6 「token-业务因果对账」无独立模块 | 09-ai-feedback-loop | **P2** | evaluator 输出接入 token 计量 → 业务产出对账（最小闭环） |
| G5 | 06「11 crm-* SKILL Action 明细未全收口」 | 06-ai-native-action-design | **P2** | 逐 SKILL 补写清单一侧（R5 同名不同侧） |

---

## Step-0：立即提交（P0，用户本地执行）

当前 `git status`（14:0x 实测）：12+ M + 25+ untracked，包括：

- **M**：`src/mcp/{server,tools}.js`、`src/page/{renderer,schema}.js`、`src/http/routes.js`、`src/skills/seed.js`、`skills/method-presales/SKILL.md`、`plugin/*`（14 个 SKILL.md + avatars + zip）、`crm-native-plugin.zip`、`.workbuddy/memory/2026-08-26.md`、`docs/superpowers/plans/2026-08-26-role-confirm-permission.md`
- **??**：`src/http/{configRouter,particleDetailRouter}.js`、`src/page/permissionComposer.js`、`src/pages/`、`src/sevenDimensions/`、`db/migrate-config.sql`、`plugin/openclaw.plugin.json`、`docs/2026-08-26-ai-10-capability-landing-audit.md`

**本地分 5 笔提交建议**（与并行工作线隔离）：

```bash
# ① 前端面（本次审计中 portal/sevenDimensions/config 面）
git add src/pages/ src/sevenDimensions/ src/http/configRouter.js src/http/particleDetailRouter.js src/page/permissionComposer.js db/migrate-config.sql docs/superpowers/plans/2026-08-26-frontend-config-pages-master-plan.md docs/superpowers/plans/2026-08-26-role-confirm-permission.md
git commit -m "feat(frontend): Config 面 33 Schema + 七维引擎 + 角色确认权限（蓝图+计划落地）"

# ② AGE 决策网络 + MCP（semantica 线）
git add src/decision/ src/mcp/ src/ontology/ageSync.js db/enable-age.sql db/migration-*.sql src/http/routes.js src/skills/seed.js
git commit -m "feat(age+mcp): 决策网络 AGE 查询面 + MCP 对外分发（写两阶段）"

# ③ 技能/插件包（ClawHub 打包线）
git add skills/ plugin/ crm-native-plugin.zip
git commit -m "feat(plugin): 12 SKILL + method-presales + ClawHub 打包（avatar+openclaw.plugin.json）"

# ④ 10 能力审计（本次新文档）
git add docs/2026-08-26-ai-10-capability-landing-audit.md
git commit -m "docs(audit): 十能力落地审计报告"

# ⑤ 记忆日志（本线工作记忆）
git add .workbuddy/memory/2026-08-26.md
git commit -m "chore(memory): 2026-08-26 工作日志"
```

> ⚠️ 若并行会话仍在改 `src/http/routes.js` 等共享文件，建议先与并行线确认，避免冲突；分笔粒度可再调整。

---

## Task G1：10-审计单点钩子（P1）

### 目标
10-ai-capability-audit V5「审计写钩子=粒子写通道单点必经」+ V2「12 业务域全覆盖」+ V3「价格/审批记录=审计事件流」。

### 现状（file:line 证据）
- `src/particles/particleRepo.js`：`createParticle:10-38`（写路径）、`updateParticle:54-81`（写路径）、`createEdge:87-114`（受控边写）——**无审计钩子调用**。
- `src/action/executor.js:82-101`：写 Action 请求/执行成功/失败三段 emit trace——**无审计写**。
- `src/kanban/kanban.js:9-11`：`auditTransition` 写 `task_audit`——审计分散在 task 域。
- `src/decision/provenance.js:10-22`：`decision_provenance` append-only + SHA-256——审计分散在 decision 域。
- `src/approval/compensation.js`：审批快照——审计分散在 approval 域。

### 设计
新建 `src/action/auditHook.js` —— **审计单点钩子**（机制级必经）：

```js
// src/action/auditHook.js — 审计单点钩子（10 文档 §3.2 机制级强制：粒子写通道必经）
// 纪律：append-only（无 update/delete）；写入失败不阻断主写（fail-open 审计 vs 非阻断主事务）
import { query } from '../db.js';

export async function ensureAuditSchema() {
  await query(`CREATE TABLE IF NOT EXISTS crm.audit_event (
    id BIGSERIAL PRIMARY KEY,
    target_particle_type text NOT NULL,      -- LEAD→ORDER 12 域 + approval/price
    source text NOT NULL,                    -- particle / action / external_skill / approval / price
    action text NOT NULL,                    -- 写动作名（create/update/submit/approve/rollback/price_change…）
    actor text,                              -- 执行者（人/Agent/自动）
    decision_id uuid,                        -- 写第0闸强制携带的决策 id
    payload jsonb,                           -- 当时全字段（含 price_change_reason / approval_instance_id）
    checksum text,                           -- SHA-256（链式，对齐 decision_provenance 范式）
    previous_checksum text,
    created_at timestamptz DEFAULT now()
  )`);
}

// 审计单点：所有粒子写通道必经（粒子 repo / 写 Action executor / 审批补偿 / 价格变更）
export async function recordAudit({ target_particle_type, source, action, actor = 'system', decision_id = null, payload = {} }) {
  const prev = (await query(
    `SELECT checksum FROM crm.audit_event ORDER BY id DESC LIMIT 1`
  )).rows[0];
  const previous_checksum = prev ? prev.checksum : null;
  const canonical = JSON.stringify(payload);
  const checksum = sha256((previous_checksum || '') + '|' + canonical);
  try {
    await query(
      `INSERT INTO crm.audit_event (target_particle_type, source, action, actor, decision_id, payload, checksum, previous_checksum)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [target_particle_type, source, action, actor, decision_id, JSON.stringify(payload), checksum, previous_checksum]
    );
    return { ok: true };
  } catch (e) {
    // 审计失败不阻断主写（fail-open；可观测：emit trace 审计失败）
    return { ok: false, error: e.message };
  }
}
```

### TDD 任务
| Task | 内容 | 测试 | 验收 |
|---|---|---|---|
| G1-T1 | 新建 `auditHook.js`（ensureAuditSchema + recordAudit + sha256） | `test/audit-hook.test.js`（schema 幂等 / recordAudit 落库 / 链式 checksum 连续） | 3/3 绿 |
| G1-T2 | `particleRepo.js` 三写路径挂 `recordAudit`（createParticle:36 前 / updateParticle:79 前 / createEdge:106 前） | `test/audit-hook.test.js` 扩展：create/update/edge 三写各产生 audit_event 行 | +3 绿 |
| G1-T3 | `executor.js` 写 Action 路径挂 `recordAudit`（`:82-101` 三段：requested/executed/failed） | 扩展：写 Action 成功/失败产生 audit_event（source='action'） | +2 绿 |
| G1-T4 | 审批补偿 + 价格变更挂审计（`approval/compensation.js` + `priceCalc.js:32` 留痕处） | 扩展：补偿回滚 / 价格变更产生 audit_event（source='approval'/'price'） | +2 绿 |
| G1-T5 | `db/schema.sql` 增 `audit_event` 表（幂等）+ `db/migrate.js` 同步 | `db.test.js` schema 断言扩展 | +1 绿 |

**验收判据（对应 10 文档 V2/V3/V5）**：
- V5：`grep recordAudit` 命中 → 粒子写通道（particleRepo）×3 + 写 Action executor + 审批/价格 = **单点钩子存在且必经**。
- V2：`audit_event` 聚合 `target_particle_type` 覆盖 LEAD→ORDER 12 域（种子后验证）。
- V3：价格变更 `source='price'`、审批 `source='approval'` 行存在（含 `price_change_reason` / `approval_instance_id` payload 字段）。

---

## Task G2：07 文档修订（P1）

### 目标
07-ai-event-driven-evolution §5-2「无定时任务式预警（D4）」与 `timers.js:31-68`（30min 扫描）相悖 → **文档澄清**。

### 现状（file:line 证据）
- `docs/2026-08-25-07-ai-event-driven-evolution.md:212`：验收判据 2「无定时任务式预警：代码库无 cron / 周期扫描预警逻辑；预警统一由写事件 / 外部连接器事件触发（D4 验收）」。
- `src/scheduler/timers.js:31-38`（crm-risk 30min 扫描）、`:42-68`（lead 池回收 30min 扫描）——**均只发射预警事件、不直接跨粒子写**（回收动作由 Action 显式触发）。

### 判定
扫描是「**规则治理兜底**（组织配置驱动的周期检查）」，非「预警业务逻辑定时触发」——语义上不违「预警=事件驱动统一源」。但文档条款过分绝对，需澄清。

### TDD 任务
| Task | 内容 | 验收 |
|---|---|---|
| G2-T1 | 修订 07 文档 §5-2：改为「**预警触发 = 事件驱动（写事件/外部连接器）为主 + 规则治理兜底（周期扫描仅发射预警事件、不直接写，回收/处置动作仍由 Action 显式触发）**」；同步 §6「不做的事」同条款 | 文档 diff 无歧义；与 `timers.js` 注释（:2「定时规则驱动的数据产生」）一致 |
| G2-T2 | （可选强化，防误读）`timers.js:31`/`:42` 注释补一句「本扫描只 emit 预警事件不跨粒子写，符合 07 §5-2 修订口径」 | 注释与文档互证 |

> 不改造代码（扫描是合理治理兜底；改事件触发反而复杂化）。若用户坚持「零定时」，则改为「扫描结果落 `alert` 表再由 SSE 推」，另行评估。

---

## Task G3：08 待办工作台四视角（P2）

### 目标
08-ai-portal-page-generation §5「待办工作台四视角（待我审批/我处理的/我发起的/抄送我的）成品页」——复用既有渲染器 + `src/pages/` schema 注册。

### 现状（file:line 证据）
- `src/pages/`：`registry.js` + `index.js` + `S01/S02/S13/S14/S15/S25.schema.js`（schema 注册，非成品页）。
- `src/page/renderer.js:154`（renderPage 唯一渲染出口）、`pageStore.js:15-27`（guard→validate→render）。
- `src/web/`：`home.html`（登录+状态墙）、`index.html`（AI 作战室）、`sales-decision-monitor.html`（决策监控）。
- `src/approval/engine.js`（startInstance）、`src/http/routes.js`（routes 挂载）。

### 设计
新建 `src/pages/S33-workbench.schema.js`（待办工作台 Schema，复用 `CANONICAL_NAV` 扩展后的组件），`src/pages/registry.js` 注册；`src/http/routes.js` 挂 `/workbench`；渲染器不改（纯函数消费 schema）。

Schema 四视角：
- **待我审批**：筛 `approval_instance.status='pending' AND approver=当前角色/人`
- **我处理的**：筛 `tasks.actor=当前人 OR status='running'`
- **我发起的**：筛 `tasks.creator=当前人 OR approval_instance.submitter=当前人`
- **抄送我的**：筛 `tasks.cc=当前人 OR approval_instance.cc=当前人`

### TDD 任务
| Task | 内容 | 测试 | 验收 |
|---|---|---|---|
| G3-T1 | 新建 `S33-workbench.schema.js`（四视角页型 Schema：`approval-filter` / `my-tasks` / `my-initiated` / `cc-me` 四组件） | `test/page/workbench.schema.test.js`（schema 合法 + 四组件齐备 + 过 validator） | 4/4 绿 |
| G3-T2 | `src/pages/registry.js` 注册 S33 + `src/http/routes.js` 挂 `GET /workbench`（复用 renderPage） | `test/http/workbench-routes.test.js`（GET /workbench 200 + 视角参数过滤） | 2/2 绿 |
| G3-T3 | 成品页 `src/web/workbench.html`（四视角标签页 + 复用 `renderPage` 产出的 HTML 容器 + SSE 实时刷新） | `test/page/workbench-page.test.js`（页面可渲染 + 四视角切换逻辑） | 3/3 绿 |

**验收判据（对应 08 §5）**：
- 四视角默认页可访问（`GET /workbench?view=approval|processing|initiated|cc`）。
- 复用同一渲染器（无新专用页面代码路径）；过三层护栏。

---

## Task G4：09-V6 token-业务对账（P2）

### 目标
09-ai-feedback-loop §5-V6「Token-业务因果对账：每条回路「烧 token vs 业务产出」可观测」。

### 现状（file:line 证据）
- `src/alerts/feedbackMetrics.js`：per-tier 指标（自主率/升级率/推翻率/时延）——**无 token 计量**。
- `src/aiAttributes/evaluator.js:7/31`：`revenue_forecast` 兜底（无 LLM 注入，置信 0.7）——**无 token 采集**。
- 全局 `grep tokensConsumed` 零命中——无 token 对账模块。

### 设计
新建 `src/alerts/tokenAccounting.js` —— token 计量 + 业务产出对账（最小闭环）：
- `recordTokens({ actor, action, tokensIn, tokensOut, source })` → `crm.token_accounting` 表（append-only）。
- `reconcileTokenToBusiness({ actor, since })` → 输出「烧 token vs 业务产出」（业务产出 = 该段时间内该 actor 的写 Action 成功数 + 决策升级数 + 审计事件数，从 `audit_event` 聚合——与 G1 联动）。

### TDD 任务
| Task | 内容 | 测试 | 验收 |
|---|---|---|---|
| G4-T1 | 新建 `tokenAccounting.js`（ensureSchema + recordTokens + reconcile） | `test/token-accounting.test.js`（落库 / 对账聚合 / 幂等） | 3/3 绿 |
| G4-T2 | `executor.js` 写 Action 执行点（:88）挂 `recordTokens`（从 `ctx` 读 tokensIn/Out，未提供则 0） | 扩展测试：写 Action 执行后 token_accounting 行存在 | +1 绿 |
| G4-T3 | `db/schema.sql` + `db/migrate.js` 增 `token_accounting` 表 | `db.test.js` 扩展 | +1 绿 |

**验收判据（对应 09 §5-V6/V7）**：
- `token_accounting` 表有真实行（写 Action 后）。
- `reconcileTokenToBusiness` 返回「token 总量 + 业务产出计数」二元组，非报表式静态。

---

## Task G5：06 11 SKILL Action 明细收口（P2）

### 目标
06-ai-native-action-design §5-1「11 个 crm-* SKILL 全部明细化为 Action 表面：每个有读清单 + 写清单，无 ×4 CRUD 爆炸」。

### 现状（file:line 证据）
- `src/skills/seed.js`：AGENT_SKILLS 4 个（crm-native/query/write/risk）+ METHOD_SKILLS 7 个。
- `src/action/seed-actions.js`：Action 表面已含 quote/contract/invoice/order 四写域（:262-336 等），但 **SKILL.md 与 Action 表面的映射清单未逐 SKILL 收口**（部分 SKILL 只有读清单一侧）。

### 设计
对 `skills/crm-{native,query,write,risk}/SKILL.md` + `method-*`/`method-presales`，逐 SKILL 补「该 SKILL 可调用的读 Action + 写 Action」两张清单（R5 同名不同侧），与 `src/action/seed-actions.js` 实际注册的 Action 一一对应（防文档与表面漂移）。

### TDD 任务
| Task | 内容 | 测试 | 验收 |
|---|---|---|---|
| G5-T1 | 逐 SKILL.md 补读/写 Action 清单（对照 seed-actions.js 实际 Action 名） | `test/skills-action-mapping.test.js`：SKILL.md 中列出的 Action 名 ⊆ seed-actions.js 注册集合（防漂移） | 11 SKILL × 断言全过 |
| G5-T2 | （联动）`src/mcp/tools.js` 暴露的 Action 与 SKILL 清单互查（外部调用 = SKILL 消费面） | 扩展：tools.js Action ⊆ seed-actions.js | +1 绿 |

**验收判据（对应 06 §5-1/§5-11）**：
- 每 SKILL.md 有「读清单 + 写清单」两节；清单 Action 名与 seed-actions.js 注册集合一致。
- 无 ×4 CRUD 爆炸（仍 0 个 delete Action，红线扫描零命中）。

---

## 执行顺序与依赖

```
Step-0（本地提交） → G1（审计单点钩子，10 能力 P1） → G2（07 文档修订，P1）
   → G3（08 门户四视角，P2） → G4（09 token 对账，P2，依赖 G1 的 audit_event 聚合）
   → G5（06 SKILL 明细，P2）
```

- **G1 先行**：审计单点钩子是 10 能力硬判据（V5），且 G4 对账依赖 `audit_event` 聚合。
- **G2 纯文档**：无代码依赖，任意时点可做。
- **G3/G5 独立**：可并行（不同文件域）。
- **全量回归**：每 Task 完成跑 `node node_modules/vitest/vitest.mjs run` 对应测试集 + 全量（当前基线 482 绿 / 67 文件）。

## 关键约束
- **设计已批准**：G1-G5 均在上一轮审计报告中给出建议并经用户「给出修复计划」触发；若实施前有新的设计分歧，走 brainstorming 一次一问定方案再动手。
- **每 Task 一 commit**：沙箱无 git 凭证，代码落盘后由用户本地「Git一下」分笔提交。
- **不擅删端点/表**：G1 新建 `audit_event` 表为增量，不动 `task_audit`/`decision_provenance` 既有审计；G4 新建 `token_accounting` 为增量。
- **07 不改代码**（除非用户明确要求零定时）：先走文档修订口径。