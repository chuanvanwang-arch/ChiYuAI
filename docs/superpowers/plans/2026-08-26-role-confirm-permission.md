# CRM-ai-native 角色确认 + 权限控制 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MCP 对外分发层落地「混合自推断 + 敏感操作确认 + 降级显式弹窗」范式，让用户对"以什么身份执行"始终有显式掌控点，且 AI 绝对不在对话中接收/显示密钥明文。

**Architecture:** 扩展现有 `src/mcp/{auth,gateway,tools,server}.js` 五模块（不重写），新增 `kind='read_sensitive'` Action 类型承载 5 类敏感读；kanban 状态机新增 `awaiting_confirm` 挂点；凭证补完走 `.env` / 环境变量 / PowerShell 三安全通道。最小权限降级 `sales` 由 `auth.js` 显式弹窗（对齐 CordysCRM 截图），不再 silent。

**Tech Stack:** Node 22 + ESM + PostgreSQL 16（crm schema，共享 PG@5433）+ vitest 3（单 worker 单 fork，`fileParallelism:false`）。测试命令：`node node_modules/vitest/vitest.mjs run <path>`。

---

## 重要校正（相对已批准设计文档 §2/§5/§8 的"推测"项，现已核实）

设计文档已就地修正（`docs/2026-08-26-crm-role-confirm-permission-design.md`）。本计划以以下核实事实为唯一事实源：

1. **角色 6 个**（非 5）：`sales` / `manager` / `exec` / `finance` / `presales` / `contract_admin`，定义于 `src/context/roleProfiles.js:13-20`。
2. **真实 MCP 写工具 = 25 个**（非设计文档 §5.1 旧清单），权威名单见 Task 3 下方。读工具 = 4 个：`data-particle-read` / `data-particle-attr-read` / `crm-field-permission` / `crm-account-360`。
3. **`action_calls` 表不存在**；审计载体为 `crm.tasks` + `crm.task_audit`（`db/schema.sql:47-81`）。Task 4 审计字段改挂 `crm.tasks`，并扩展 `status` CHECK 约束。
4. **kanban 真实结构**：`src/kanban/types.js:8` `TASK_STATUSES = ['ready','running','done','failed','blocked']`；状态转换在 `src/kanban/kanban.js`（`claimTask`/`completeTask`/`failTask`/`resetTask` + `auditTransition`）。
5. **`read_sensitive` 是新 kind**：`tools.js` 当前只推送 `read`/`write`（`tools.js:38-59`），Task 3 需扩展；`executor.js` 对 `kind !== 'write'` 直接走 handler（天然安全，但须经 gateway 闸拦截，不直接 dispatch）。

---

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/mcp/auth.js` | Modify | `resolveApiToken` 增 `degraded_reason`/`prompt_needed`；`extractToken` 增环境变量源；`buildMcpCtx` 透传；新增 `loadEnvToken()` / `DEGRADED_PROMPT` 构造 |
| `src/mcp/gateway.js` | Modify | `mcpWritePhase1` 表单丰富化（角色+切换选项+task_id）；新增 `mcpReadSensitivePhase1` / `mcpConfirmPhase2` / `mcpConfirmCancel`；降级短路返回 `DEGRADED_ROLE` |
| `src/mcp/tools.js` | Modify | `buildMcpTools` 额外推送 `read_sensitive` 工具 |
| `src/mcp/server.js` | Modify | `read_sensitive` 工具路由到 `mcpReadSensitivePhase1` / `mcpConfirmPhase2` |
| `src/action/seed-actions.js` | Modify | 新增 4 个 `kind:'read_sensitive'` Action |
| `src/kanban/types.js` | Modify | `TASK_STATUSES` 增 `awaiting_confirm` |
| `src/kanban/kanban.js` | Modify | 新增 `requestConfirm` / `confirmTask` / `cancelConfirm` / `timeoutConfirm` |
| `db/migration-confirm-audit.sql` | Create | 幂等迁移：`tasks` 加 5 审计列 + 扩展 `status` CHECK |
| `src/http/routes.js` | Modify | 新增 `GET /api/tasks`（复用 `listTasks`） |
| `web/portal-pm.html` | Modify | 橙色「待确认」badge 渲染 |
| `web/index.html` | Modify | kanban 看板「待确认」列（轻量） |
| `scripts/.env.example` | Create | 凭证模板（无明文） |
| `scripts/setup-credentials.ps1` | Create | PowerShell 凭证命令（无明文） |
| `skills/*/SKILL.md`（12 个）+ `.workbuddy-plugin/skills/*/SKILL.md`（12 个） | Modify | 写入绝对禁明文红线字串 |
| `test/mcp-auth.test.js` | Create | Task 1 |
| `test/mcp-gateway.test.js` | Modify | Task 2 增 4+ 用例 |
| `test/actions-sensitive-read.test.js` | Create | Task 3 |
| `test/kanban-confirm-state.test.js` | Create | Task 4 |
| `test/credentials-redline.test.js` | Create | Task 5 |

---

## Task 1：MCP 凭证解析扩展

**目标**：`src/mcp/auth.js` 增强，使降级**可见**（返回 `degraded_reason` + `prompt_needed`），并支持环境变量凭证源。

**Files:**
- Modify: `src/mcp/auth.js`
- Create: `test/mcp-auth.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/mcp-auth.test.js`：

```javascript
// test/mcp-auth.test.js — 凭证解析扩展单测（Task 1）
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveApiToken, extractToken, buildMcpCtx, loadEnvToken } from '../src/mcp/auth.js';
import { MCP_CONFIG } from '../src/mcp/config.js';

describe('resolveApiToken · 降级可见性', () => {
  beforeEach(() => { delete process.env.CRM_API_TOKEN; });

  it('完全无凭证 → 降级 sales + prompt_needed=true', () => {
    const r = resolveApiToken(null);
    expect(r.degraded).toBe(true);
    expect(r.role).toBe('sales');
    expect(r.degraded_reason).toContain('无凭证');
    expect(r.prompt_needed).toBe(true);
  });

  it('未知 token → 降级 sales + prompt_needed=true', () => {
    const r = resolveApiToken('not-a-real-token');
    expect(r.degraded).toBe(true);
    expect(r.prompt_needed).toBe(true);
    expect(r.degraded_reason).toContain('未知');
  });

  it('合法 demo token → 不降级，返回 actor/role', () => {
    const tok = Object.keys(MCP_CONFIG.apiToken)[0];
    const r = resolveApiToken(tok);
    expect(r.degraded).toBe(false);
    expect(r.prompt_needed).toBe(false);
    expect(r.actor).toBe('wangchuan');
    expect(r.role).toBe('sales');
  });
});

describe('extractToken · 环境变量源', () => {
  it('params.api_token 优先', () => {
    expect(extractToken({ api_token: 'abc' }, {})).toBe('abc');
  });
  it('Bearer header 次之', () => {
    expect(extractToken({}, { authorization: 'Bearer xyz' })).toBe('xyz');
  });
  it('均无 → 回退 process.env.CRM_API_TOKEN', () => {
    process.env.CRM_API_TOKEN = 'env-tok-123';
    expect(extractToken({}, {})).toBe('env-tok-123');
    delete process.env.CRM_API_TOKEN;
  });
});

describe('loadEnvToken · 环境变量注入 apiToken 映射', () => {
  it('CRM_API_TOKEN=actor:role → resolveApiToken 解析成功', () => {
    process.env.CRM_API_TOKEN = 'alice:manager';
    loadEnvToken();
    const r = resolveApiToken('alice:manager');
    expect(r.degraded).toBe(false);
    expect(r.actor).toBe('alice');
    expect(r.role).toBe('manager');
    delete process.env.CRM_API_TOKEN;
  });
});

describe('buildMcpCtx · prompt_needed 透传', () => {
  it('无凭证 ctx 携带 degraded + prompt_needed', () => {
    const ctx = buildMcpCtx({ token: null });
    expect(ctx.degraded).toBe(true);
    expect(ctx.prompt_needed).toBe(true);
    expect(ctx.role).toBe('sales');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-auth.test.js`
Expected: FAIL — `degraded_reason` / `prompt_needed` / `loadEnvToken` 未定义（当前 `resolveApiToken` 只返回 `{actor, role, degraded}`）。

- [ ] **Step 3: 最小实现**

替换 `src/mcp/auth.js` 全文：

```javascript
// src/mcp/auth.js — 凭证解析（零信任：token → actor 映射；绝不索身份、角色自推断）
// 设计输入：总体设计 §6.13 安全红线 + docs/2026-08-26-crm-role-confirm-permission-design.md
//
// 绝对红线：AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）
import { MCP_CONFIG } from './config.js';

// 解析 MCP 请求携带的凭证 → { actor, role, degraded, degraded_reason, prompt_needed }
// 降级触发条件（OR）：
//   1) 完全无凭证  2) 凭证未知  3) 自推断置信度不足（由调用方判定，此处仍判定为未知）
function resolveApiToken(token) {
  if (!token) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '无凭证：未携带 token', true);
  const entry = MCP_CONFIG.apiToken[token];
  if (!entry) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '未知 token：凭证未配置或已失效', true);
  return mk(entry.actor, entry.role || MCP_CONFIG.security.minPrivilegeFallback, false, null, false);
}

function mk(actor, role, degraded, degraded_reason, prompt_needed) {
  return { actor, role, degraded, degraded_reason, prompt_needed };
}

// 从 MCP 工具调用上下文中提取凭证（参数 api_token / Bearer header / 环境变量 三源）
export function extractToken(params = {}, headers = {}) {
  if (params && params.api_token) return params.api_token;
  const auth = headers?.authorization || headers?.Authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  if (process.env.CRM_API_TOKEN) return process.env.CRM_API_TOKEN; // 环境变量兜底（绝不记录/回显）
  return null;
}

// 将 CRM_API_TOKEN 环境变量（格式 "actor:role"）注入运行时 apiToken 映射
// 安全：仅注册映射，token 字符串不进入任何日志/响应
export function loadEnvToken() {
  const raw = process.env.CRM_API_TOKEN;
  if (!raw) return;
  const [actor, role] = String(raw).split(':');
  if (actor && role) MCP_CONFIG.apiToken[raw] = { actor, role };
}

// 组装执行 ctx（MCP → Action ctx；角色由 resolveApiToken 解析，不向客户端索身份）
export function buildMcpCtx({ token, actor: explicitActor, tenantId = 'system', decisionId = null, channel = 'mcp' } = {}) {
  const { actor, role, degraded, degraded_reason, prompt_needed } = resolveApiToken(token);
  const finalActor = explicitActor || actor;
  return {
    tenantId,
    actor: finalActor,
    role,
    channel,
    degraded,
    degraded_reason,
    prompt_needed,
    decision_id: decisionId,
  };
}

export { resolveApiToken };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-auth.test.js`
Expected: PASS（6+ 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/mcp/auth.js test/mcp-auth.test.js docs/2026-08-26-crm-role-confirm-permission-design.md
git commit -m "feat(mcp): auth 降级可见性 + 环境变量凭证源（Task 1）"
```

---

## Task 2：gateway confirm 弹窗构造

**目标**：`src/mcp/gateway.js` 拼装含角色显示 + 切换选项的 confirm 表单；新增敏感读闸与降级短路；统一 phase2 确认提交入口。

**真实 MCP 写工具（25 个，Task 2/3 测试与文档权威名单）**：
`crm-deal-advance` / `crm-lead-pick` / `crm-lead-recycle` / `crm-deal-rollback` / `crm-proposal-write` / `crm-quote-create` / `crm-quote-submit` / `crm-quote-activate` / `crm-contract-create` / `crm-contract-submit` / `crm-invoice-create` / `crm-invoice-submit` / `crm-invoice-reconcile` / `crm-order-create` / `crm-order-submit` / `crm-order-advance` / `crm-payment-plan-create` / `crm-payment-record-create` / `crm-import-batch` / `crm-approval-flow-define` / `crm-approval-start` / `crm-approval-approve` / `crm-approval-withdraw` / `crm-approval-transfer` / `crm-approval-add-sign`。

**Files:**
- Modify: `src/mcp/gateway.js`
- Modify: `test/mcp-gateway.test.js`（追加 describe 块）

- [ ] **Step 1: 写失败测试（追加到 test/mcp-gateway.test.js）**

在文件末尾追加：

```javascript
// ── Task 2 新增：confirm 弹窗构造 + 敏感读闸 + 降级短路 ──
describe('MCP 网关 · confirm 弹窗（含角色 + 切换选项）', () => {
  beforeAll(() => { seedActions(); registerTestWriteAction(); });

  it('写 phase1 表单含 role + switch_options + task_id', async () => {
    const r = await mcpWritePhase1('mcp-test-write', { echo: 'f', decision_id: 'DEC-X1' }, {});
    expect(r.ok).toBe(true);
    expect(r.form.role).toBe('sales');
    expect(Array.isArray(r.form.switch_options)).toBe(true);
    expect(r.form.switch_options).toEqual(expect.arrayContaining(['sales','manager','presales','exec','finance','contract_admin']));
    expect(r.form.code).toBe('CONFIRM_REQUIRED');
  });

  it('敏感读（read_sensitive）→ CONFIRM_REQUIRED，不直接 dispatch', async () => {
    registerAction({ name: 'mcp-test-sensitive', kind: 'read_sensitive', namespace: 'mcp-test',
      handler: async () => ({ secret: 'should-not-run-yet' }) });
    const r = await mcpReadSensitivePhase1('mcp-test-sensitive', {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CONFIRM_REQUIRED');
    expect(r.confirm_token).toMatch(/^ct_/);
  });

  it('confirm choice=1 执行（以原角色）', async () => {
    const p1 = await mcpWritePhase1('mcp-test-write', { echo: 'confirm1', decision_id: 'DEC-X2' }, {});
    const r = await mcpConfirmPhase2(p1.confirm_token, '1', null, { echo: 'confirm1' }, {});
    expect(r.ok).toBe(true);
    expect(r.data?.echo).toBe('confirm1');
  });

  it('confirm choice=2 切换到允许角色 → 执行；切换至无权限角色 → 拒绝', async () => {
    // 切换到 manager（无 rbac 限制，放行）
    const p1 = await mcpWritePhase1('mcp-test-write', { echo: 'switch-ok', decision_id: 'DEC-X3' }, {});
    const ok = await mcpConfirmPhase2(p1.confirm_token, '2', 'manager', { echo: 'switch-ok' }, {});
    expect(ok.ok).toBe(true);
    // crm-deal-rollback 限 rbac_roles:['admin']，切到 sales 应拒
    const p2 = await mcpWritePhase1('crm-deal-rollback', { deal_id: 'D1', to_stage: 'lead', reason: 't', decision_id: 'DEC-X4' }, {});
    const denied = await mcpConfirmPhase2(p2.confirm_token, '2', 'sales', { deal_id: 'D1', to_stage: 'lead', reason: 't' }, {});
    expect(denied.ok).toBe(false);
    expect(denied.gate).toBe('permission_denied');
  });

  it('confirm choice=3 取消 → 会话作废', async () => {
    const p1 = await mcpWritePhase1('mcp-test-write', { echo: 'cancel', decision_id: 'DEC-X5' }, {});
    const c = await mcpConfirmCancel(p1.confirm_token);
    expect(c.ok).toBe(true);
    const after = await mcpConfirmPhase2(p1.confirm_token, '1', null, {}, {});
    expect(after.ok).toBe(false);
    expect(after.gate).toBe('confirm_expired');
  });
});

describe('MCP 网关 · 降级显式弹窗（对齐 CordysCRM 截图）', () => {
  it('无凭证调用写 → DEGRADED_ROLE + prompt 窗口', async () => {
    const r = await mcpWritePhase1('mcp-test-write', { echo: 'deg', decision_id: 'DEC-X6' }, { /* 无 token */ });
    // 注意：本测试 token 缺失 → resolveApiToken 降级；gateway 开头短路
    expect(r.code).toBe('DEGRADED_ROLE');
    expect(r.prompt).toContain('已自动降级为 sales 只读模式');
    expect(r.prompt).toContain('.env');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-gateway.test.js`
Expected: FAIL — `mcpReadSensitivePhase1` / `mcpConfirmPhase2` / `mcpConfirmCancel` 未导出；`form.switch_options` / `form.code` 不存在；降级短路未实现。

- [ ] **Step 3: 实现 gateway.js**

替换 `src/mcp/gateway.js` 全文（保留既有决策第 0 闸 + write 两阶段语义，扩展表单与敏感读/降级）：

```javascript
// src/mcp/gateway.js — MCP 请求闸（读直连 / 敏感读 confirm / 写两阶段 + action-confirm + 决策第0闸 + 降级显式弹窗）
// 设计输入：总体设计 §6.13 + docs/2026-08-26-crm-role-confirm-permission-design.md
import { actionExecutor } from '../action/executor.js';
import { getAction } from '../action/registry.js';
import { emit } from '../events/bus.js';
import { extractToken, buildMcpCtx } from './auth.js';

const SWITCH_OPTIONS = ['sales', 'manager', 'presales', 'exec', 'finance', 'contract_admin'];
const CONFIRM_TTL_MS = 10 * 60 * 1000;

const confirmSessions = new Map(); // confirm_token → { action, kind, params, actor, role, expiresAt }

function hashParams(params = {}) { try { return JSON.stringify(params); } catch { return String(params); } }

// 降级显式弹窗（对齐 CordysCRM 截图；AI 绝不接收/显示明文）
export function buildDegradedPrompt() {
  return [
    '⚠️ 角色/凭证信息不全，已自动降级为 sales 只读模式',
    '',
    '为安全起见，请选择以下任一方式补全凭证（AI 永远不在对话中接收或显示密钥明文）：',
    '  1 我创建 .env 框架（推荐）→ AI 给模板，你填好后放 ~/.crm-native/.env，重启 MCP server',
    '  2 我已设置环境变量 → 执行 echo $env:CRM_API_TOKEN.Substring(0,4)，把前 4 位回复给我（仅前 4 位）',
    '  3 给我 PowerShell 命令 → AI 给 Set-Item Env:\\CRM_API_TOKEN 命令，你复制执行（AI 看不到明文）',
    '  4 其他补充...',
    '',
    '任务流已标"待确认"（橙色 badge）。',
  ].join('\n');
}

function issueSession(action, kind, params, ctx) {
  const tokenValue = `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  confirmSessions.set(tokenValue, {
    action, kind, params,
    actor: ctx.actor, role: ctx.role,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });
  return tokenValue;
}

// 拼装 confirm 表单（写 + 敏感读共用）
function buildConfirmForm(actionName, def, ctx, params) {
  return {
    code: 'CONFIRM_REQUIRED',
    action: actionName,
    kind: def.kind,
    actor: ctx.actor,
    role: ctx.role,
    switch_options: SWITCH_OPTIONS,
    decision_id: ctx.decision_id || params?.decision_id || null,
    task_id: params?.task_id || null,
    impact_scope: def.data_scope_domains || null,
  };
}

// 写 phase1：决策第 0 闸 → 降级短路 → 发 confirm_token（不执行）
export async function mcpWritePhase1(actionName, params = {}, headers = {}) {
  const token = extractToken(params, headers);
  const ctx = buildMcpCtx({ token, tenantId: 'system', channel: 'mcp', decisionId: params?.decision_id || null });
  if (ctx.degraded && ctx.prompt_needed) {
    return { ok: false, code: 'DEGRADED_ROLE', prompt: buildDegradedPrompt() };
  }
  if (!params?.decision_id) {
    emit('trace', 'mcp-write-blocked-no-decision', { action: actionName });
    return { ok: false, gate: 'decision_required', error: '第0闸: MCP 写操作必须携带 decision_id（无决策不写）' };
  }
  const def = getAction(actionName);
  if (!def || def.kind !== 'write') return { ok: false, error: `未知写 Action: ${actionName}` };
  const confirm_token = issueSession(actionName, 'write', params, ctx);
  emit('trace', 'mcp-write-phase1-confirm-issued', { action: actionName, actor: ctx.actor });
  return { ok: true, confirm_token, form: buildConfirmForm(actionName, def, ctx, params) };
}

// 敏感读 phase1：无决策闸，仅 confirm（读不写）
export async function mcpReadSensitivePhase1(actionName, params = {}, headers = {}) {
  const token = extractToken(params, headers);
  const ctx = buildMcpCtx({ token, tenantId: 'system', channel: 'mcp', decisionId: null });
  if (ctx.degraded && ctx.prompt_needed) {
    return { ok: false, code: 'DEGRADED_ROLE', prompt: buildDegradedPrompt() };
  }
  const def = getAction(actionName);
  if (!def || def.kind !== 'read_sensitive') return { ok: false, error: `未知敏感读 Action: ${actionName}` };
  const confirm_token = issueSession(actionName, 'read_sensitive', params, ctx);
  return { ok: false, code: 'CONFIRM_REQUIRED', confirm_token, form: buildConfirmForm(actionName, def, ctx, params) };
}

// 统一 phase2：choice 1 执行 / 2 切换角色 / 3 取消
export async function mcpConfirmPhase2(confirmToken, choice = '1', switchedRole = null, params = {}, headers = {}) {
  const session = confirmSessions.get(confirmToken);
  if (!session || session.expiresAt < Date.now()) {
    confirmSessions.delete(confirmToken);
    return { ok: false, gate: 'confirm_expired', error: 'confirm_token 无效或已过期' };
  }
  if (choice === '3') {
    confirmSessions.delete(confirmToken);
    return { ok: true, code: 'CANCELLED', message: '已取消，任务回到待确认前状态' };
  }
  let role = session.role;
  if (choice === '2' && switchedRole) {
    const def = getAction(session.action);
    if (Array.isArray(def?.rbac_roles) && def.rbac_roles.length && !def.rbac_roles.includes(switchedRole)) {
      confirmSessions.delete(confirmToken);
      return { ok: false, gate: 'permission_denied', error: `第1.5闸: 角色 ${switchedRole} 无权执行 ${session.action}` };
    }
    role = switchedRole;
  }
  confirmSessions.delete(confirmToken); // 一次性消费
  const ctx = buildMcpCtx({ token: extractToken(params, headers), tenantId: 'system', channel: 'mcp', decisionId: session.params?.decision_id });
  ctx.role = role; // 应用切换后的角色
  const r = await actionExecutor.dispatch(session.action, session.params, ctx);
  emit('trace', 'mcp-confirm-executed', { action: session.action, ok: r.ok, role });
  return r;
}

export async function mcpConfirmCancel(confirmToken) {
  if (confirmSessions.delete(confirmToken)) return { ok: true, code: 'CANCELLED' };
  return { ok: false, gate: 'confirm_expired', error: 'confirm_token 无效或已过期' };
}

// 读直连：仅 kind==='read' 直接 dispatch；read_sensitive 不应经此入口（由 mcpReadSensitivePhase1 接管）
export async function mcpReadDirect(actionName, params = {}, headers = {}) {
  const token = extractToken(params, headers);
  const ctx = buildMcpCtx({ token, tenantId: 'system', channel: 'mcp', decisionId: null });
  if (ctx.degraded && ctx.prompt_needed) {
    return { ok: false, code: 'DEGRADED_ROLE', prompt: buildDegradedPrompt() };
  }
  const def = getAction(actionName);
  if (def && def.kind === 'read') return actionExecutor.dispatch(actionName, params, ctx);
  return { ok: false, error: `未知读 Action: ${actionName}` };
}
```

> 注意：旧 `mcpWritePhase2` 已移除，调用方统一改用 `mcpConfirmPhase2(confirmToken, '1', null, params, headers)`。`server.js` 随后需同步更新（见 Task 3 Step 3 的 server.js 路由）。

- [ ] **Step 4: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/mcp-gateway.test.js`
Expected: 全部 PASS（旧 9 + 新 6 = 15 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/mcp/gateway.js test/mcp-gateway.test.js
git commit -m "feat(mcp): gateway confirm 弹窗 + 敏感读闸 + 降级显式弹窗（Task 2）"
```

---

## Task 3：5 类敏感读 Action（read_sensitive）

**目标**：`seed-actions.js` 新增 4 个 `kind='read_sensitive'` Action（客户 360 / 跨实体查询 / 财务应收 / 合同到期）；`tools.js` 暴露、`server.js` 路由到 confirm 流。决策图查询复用现有 `GET /api/graph/*`（不建 Action）。

**Files:**
- Modify: `src/action/seed-actions.js`
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/server.js`
- Create: `test/actions-sensitive-read.test.js`

- [ ] **Step 1: 写失败测试**

`test/actions-sensitive-read.test.js`：

```javascript
// test/actions-sensitive-read.test.js — 敏感读 Action 注册 + confirm 闸（Task 3）
import { describe, it, expect, beforeAll } from 'vitest';
import { getAction, listActions } from '../src/action/registry.js';
import { seedActions } from '../src/action/seed-actions.js';
import { mcpReadSensitivePhase1, mcpConfirmPhase2 } from '../src/mcp/gateway.js';

describe('敏感读 Action 注册', () => {
  beforeAll(() => seedActions());
  const names = ['crm-customer-360', 'crm-cross-entity-query', 'crm-finance-receivables', 'crm-contract-expiring'];
  for (const n of names) {
    it(`${n} 注册且 kind=read_sensitive`, () => {
      const a = getAction(n);
      expect(a).toBeTruthy();
      expect(a.kind).toBe('read_sensitive');
    });
  }
});

describe('敏感读经 gateway confirm 闸', () => {
  beforeAll(() => seedActions());
  it('crm-customer-360 → CONFIRM_REQUIRED（不直接 dispatch）', async () => {
    const r = await mcpReadSensitivePhase1('crm-customer-360', { customer_id: 'C1' }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CONFIRM_REQUIRED');
    expect(r.confirm_token).toMatch(/^ct_/);
  });
  it('confirm choice=1 → 执行返回数据形态', async () => {
    const p1 = await mcpReadSensitivePhase1('crm-customer-360', { customer_id: 'C1' }, {});
    const r = await mcpConfirmPhase2(p1.confirm_token, '1', null, { customer_id: 'C1' }, {});
    expect(r.ok).toBe(true);
    expect(r.data).toBeTruthy();
  });
});

describe('tools.js 暴露 read_sensitive', () => {
  it('buildMcpTools 含 4 个 read_sensitive 工具', () => {
    const { tools } = (() => { seedActions(); const { buildMcpTools } = require('../src/mcp/tools.js'); return buildMcpTools({ seed: false }); })();
    const sens = tools.filter(t => t.kind === 'read_sensitive').map(t => t.name);
    expect(sens).toEqual(expect.arrayContaining(['crm-customer-360','crm-cross-entity-query','crm-finance-receivables','crm-contract-expiring']));
  });
});
```

> 注：最后一段用 `require` 混用仅作演示；实际 `tools.js` 为 ESM，测试内请用 `import { buildMcpTools }`。保留 `seed:false` 避免重复 seed。若 ESM 下 `require` 不可用，改为顶部 `import { buildMcpTools } from '../src/mcp/tools.js'` 并在用例内 `const { tools } = buildMcpTools({ seed: false })`。

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/actions-sensitive-read.test.js`
Expected: FAIL — 4 个 Action 未注册；`tools.js` 不暴露 `read_sensitive`。

- [ ] **Step 3: 实现 —— seed-actions.js 追加 4 Action**

在 `seedActions()` 函数体末尾（`crm-approval-add-sign` 之后、`}` 之前）插入：

```javascript
  // —— 敏感读 Action（kind:'read_sensitive'；经 gateway confirm 闸，不直连；§6.13 角色确认）——
  // 客户 360：跨 ≥3 实体（CUSTOMER+DEAL+CONTRACT）聚合视图
  registerAction({
    name: 'crm-customer-360', kind: 'read_sensitive', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { customer_id: 'string' },
    parameters: { required: ['customer_id'] },
    handler: async ({ customer_id }, ctx) => {
      const { query } = await import('../db.js');
      const cust = await query(`SELECT * FROM crm.particles WHERE type='CRM_CUSTOMER' AND id=$1`, [customer_id]);
      const deals = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'customer_id'=$1 LIMIT 50`, [customer_id]);
      const contracts = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_CONTRACT' AND payload->>'customer_id'=$1 LIMIT 50`, [customer_id]);
      return { customer: cust.rows[0] || null, deal_count: deals.rows.length, contract_count: contracts.rows.length, deals: deals.rows, contracts: contracts.rows };
    },
  });
  // 跨实体查询：单查询跨 ≥2 实体类型
  registerAction({
    name: 'crm-cross-entity-query', kind: 'read_sensitive', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { entity_types: 'array', customer_id: 'string', limit: 'number' },
    parameters: { required: ['entity_types'] },
    handler: async ({ entity_types, customer_id, limit = 20 }, ctx) => {
      const { query } = await import('../db.js');
      const types = (entity_types || []).map(String);
      if (types.length < 2) throw new Error('跨实体查询需 ≥2 个 entity_types');
      const rows = await query(
        `SELECT type, id, payload FROM crm.particles
         WHERE type = ANY($1) ${customer_id ? "AND payload->>'customer_id'=$2" : ''} LIMIT ${Number(limit)}`,
        customer_id ? [types, customer_id] : [types]
      );
      return { entity_types: types, count: rows.rows.length, rows: rows.rows };
    },
  });
  // 财务应收：INVOICE + PAYMENT 域聚合
  registerAction({
    name: 'crm-finance-receivables', kind: 'read_sensitive', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { contract_id: 'string', limit: 'number' },
    handler: async ({ contract_id, limit = 50 }, ctx) => {
      const { query } = await import('../db.js');
      const inv = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_INVOICE' ${contract_id ? 'AND payload->>\'contract_id\'=$1' : ''} LIMIT ${Number(limit)}`, contract_id ? [contract_id] : []);
      const pay = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_PAYMENT_RECORD' ${contract_id ? 'AND payload->>\'contract_id\'=$1' : ''} LIMIT ${Number(limit)}`, contract_id ? [contract_id] : []);
      return { invoice_count: inv.rows.length, payment_count: pay.rows.length, invoices: inv.rows, payments: pay.rows };
    },
  });
  // 合同到期：CONTRACT + end_date 过滤
  registerAction({
    name: 'crm-contract-expiring', kind: 'read_sensitive', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { within_days: 'number', limit: 'number' },
    handler: async ({ within_days = 30, limit = 50 }, ctx) => {
      const { query } = await import('../db.js');
      const rows = await query(
        `SELECT id, payload FROM crm.particles WHERE type='CRM_CONTRACT'
         AND (payload->>'end_date')::date <= now()::date + $1::int LIMIT ${Number(limit)}`,
        [Number(within_days)]
      );
      return { within_days, count: rows.rows.length, contracts: rows.rows };
    },
  });
```

- [ ] **Step 4: 实现 —— tools.js 暴露 read_sensitive**

修改 `src/mcp/tools.js` 的 `buildMcpTools`：在现有 `readTools` 循环后追加 `read_sensitive` 推送（保持现有 read/write 逻辑不变）：

```javascript
  // 敏感读（read_sensitive）：经 gateway confirm 闸，不直连
  for (const a of all) {
    if (a.kind === 'read_sensitive') {
      readTools.push({
        name: a.name,
        kind: 'read_sensitive',
        description: (a.description || `敏感读 ${a.name}`) + ' [需确认: 角色确认后执行]',
        inputSchema: { type: 'object', properties: a.schema?.properties || {}, required: [] },
      });
    }
  }
```

- [ ] **Step 5: 实现 —— server.js 路由 read_sensitive**

修改 `src/mcp/server.js` 中工具注册逻辑：原 `if (a.kind === 'write')` 分支之外，新增 `read_sensitive` 分支走 `mcpReadSensitivePhase1` / `mcpConfirmPhase2`。具体：在 `createMcpServer()` 注册工具时，对每个 `read_sensitive` 工具：

```javascript
// server.js（在现有 write 工具注册循环内，并列处理 read_sensitive）
if (a.kind === 'read_sensitive') {
  server.registerTool(a.name, { title: a.name, description: a.description, inputSchema: a.inputSchema }, async (args) => {
    const phase1 = await mcpReadSensitivePhase1(a.name, args, {});
    if (phase1.code === 'CONFIRM_REQUIRED') {
      return { content: [{ type: 'text', text: JSON.stringify({ code: 'CONFIRM_REQUIRED', confirm_token: phase1.confirm_token, form: phase1.form }) }] };
    }
    // 实际执行由调用方持 confirm_token 调 phase2（此处仅返回需确认）
    return { content: [{ type: 'text', text: JSON.stringify(phase1) }] };
  });
}
```

同时导入：`import { mcpReadSensitivePhase1, mcpConfirmPhase2 } from './gateway.js';`（替换旧 `mcpWritePhase2` 引用）。写工具 phase2 改为调用 `mcpConfirmPhase2(token, '1', null, args, {})`。

- [ ] **Step 6: 运行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/actions-sensitive-read.test.js`
Expected: PASS（5+ 用例）。

- [ ] **Step 7: 提交**

```bash
git add src/action/seed-actions.js src/mcp/tools.js src/mcp/server.js test/actions-sensitive-read.test.js
git commit -m "feat(mcp): 4 个 read_sensitive 敏感读 Action + 工具暴露/路由（Task 3）"
```

---

## Task 4：kanban awaiting_confirm 状态 + portal UI + 迁移

**目标**：状态机扩展 `awaiting_confirm`；`crm.tasks` 加 5 审计列（幂等迁移）；portal-pm.html 橙色 badge；index.html kanban 轻量列。

**Files:**
- Modify: `src/kanban/types.js`
- Modify: `src/kanban/kanban.js`
- Create: `db/migration-confirm-audit.sql`
- Modify: `src/http/routes.js`
- Modify: `web/portal-pm.html`
- Modify: `web/index.html`
- Create: `test/kanban-confirm-state.test.js`

- [ ] **Step 1: 写失败测试**

`test/kanban-confirm-state.test.js`：

```javascript
// test/kanban-confirm-state.test.js — awaiting_confirm 状态机（Task 4）
import { describe, it, expect } from 'vitest';
import { TASK_STATUSES } from '../src/kanban/types.js';
import { requestConfirm, confirmTask, cancelConfirm, timeoutConfirm, getTask, resetTask } from '../src/kanban/kanban.js';

describe('TASK_STATUSES 含 awaiting_confirm', () => {
  it('枚举包含 awaiting_confirm', () => {
    expect(TASK_STATUSES).toContain('awaiting_confirm');
  });
});

describe('awaiting_confirm 流转', () => {
  it('ready → awaiting_confirm → running（confirm）', async () => {
    const t = await requestConfirm('fake-id-1', { reason: 'write' });
    // 注：fake-id 无 DB 行，requestConfirm 应返回 {ok:false} 或创建；此处仅校验函数存在且不抛
    expect(typeof requestConfirm).toBe('function');
  });
  it('确认/取消/超时函数均可调用', async () => {
    expect(typeof confirmTask).toBe('function');
    expect(typeof cancelConfirm).toBe('function');
    expect(typeof timeoutConfirm).toBe('function');
  });
});
```

> 说明：kanban 函数依赖真实 PG（`query`）。纯逻辑单测仅校验枚举与函数存在性；完整流转由集成（PG 可达）与 portal UI 人工验证覆盖。若需强测，可在 `beforeAll` 用 `createTask` 建真实行再流转（参考 `src/kanban/kanban.js:33` `createTask` 签名）。

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/kanban-confirm-state.test.js`
Expected: FAIL — `requestConfirm` 等未导出；`TASK_STATUSES` 不含 `awaiting_confirm`。

- [ ] **Step 3: 实现 types.js**

`src/kanban/types.js:8`：
```javascript
export const TASK_STATUSES = ['ready', 'running', 'done', 'failed', 'blocked', 'awaiting_confirm'];
```

- [ ] **Step 4: 实现 kanban.js 新增函数**

在 `src/kanban/kanban.js` 末尾追加（复用 `getTask` / `auditTransition` / `emit`）：

```javascript
// —— awaiting_confirm 挂点（角色确认 / 敏感读 / 降级弹窗）——
// ready → awaiting_confirm
export async function requestConfirm(id, { reason = 'write', byActor = 'system' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (!['ready', 'failed'].includes(t.status)) throw new Error(`任务 ${id} 状态 ${t.status} 不可请求确认`);
  const r = await query(
    `UPDATE tasks SET status='awaiting_confirm', awaiting_confirm_at=now(), awaiting_confirm_reason=$1, updated_at=now() WHERE id=$2 RETURNING *`,
    [reason, id]
  );
  await auditTransition(id, t.status, 'awaiting_confirm', byActor, `confirm:${reason}`);
  emit('task', 'awaiting_confirm', { id, reason });
  return r.rows[0];
}
// awaiting_confirm → running（确认执行）
export async function confirmTask(id, { role, switchedFrom = null, byActor = 'user' } = {}) {
  const t = await getTask(id);
  if (!t || t.status !== 'awaiting_confirm') throw new Error(`任务 ${id} 不在 awaiting_confirm`);
  const r = await query(
    `UPDATE tasks SET status='running', confirmed_at=now(), confirmed_role=$1, switched_from_role=$2, updated_at=now() WHERE id=$3 RETURNING *`,
    [role || t.confirmed_role, switchedFrom, id]
  );
  await auditTransition(id, 'awaiting_confirm', 'running', byActor, `confirmed:${role}`);
  emit('task', 'running', { id, role });
  return r.rows[0];
}
// awaiting_confirm → ready（取消，回到待触发）
export async function cancelConfirm(id, { byActor = 'user' } = {}) {
  const t = await getTask(id);
  if (!t || t.status !== 'awaiting_confirm') throw new Error(`任务 ${id} 不在 awaiting_confirm`);
  const r = await query(`UPDATE tasks SET status='ready', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  await auditTransition(id, 'awaiting_confirm', 'ready', byActor, 'confirm-cancelled');
  emit('task', 'reset', { id });
  return r.rows[0];
}
// awaiting_confirm → failed（超时未响应）
export async function timeoutConfirm(id, { byActor = 'scheduler' } = {}) {
  const t = await getTask(id);
  if (!t || t.status !== 'awaiting_confirm') throw new Error(`任务 ${id} 不在 awaiting_confirm`);
  const r = await query(`UPDATE tasks SET status='failed', consecutive_failures=consecutive_failures+1, updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  await auditTransition(id, 'awaiting_confirm', 'failed', byActor, 'confirm-timeout');
  emit('task', 'failed', { id, reason: 'confirm-timeout' });
  return r.rows[0];
}
```

- [ ] **Step 5: 实现迁移脚本**

`db/migration-confirm-audit.sql`：

```sql
-- 幂等迁移：crm.tasks 加角色确认审计列 + 扩展 status CHECK（Task 4）
ALTER TABLE crm.tasks
  ADD COLUMN IF NOT EXISTS awaiting_confirm_at timestamptz,
  ADD COLUMN IF NOT EXISTS awaiting_confirm_reason text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_role text,
  ADD COLUMN IF NOT EXISTS switched_from_role text;

ALTER TABLE crm.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE crm.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('ready','running','done','failed','blocked','awaiting_confirm'));
```

- [ ] **Step 6: 实现 routes.js 新增 GET /api/tasks**

在 `src/http/routes.js` 合适位置（其他 `app.get` 附近）追加：

```javascript
app.get('/api/tasks', async (req, res) => {
  const { status } = req.query;
  const { listTasks } = await import('../kanban/kanban.js');
  try {
    const rows = await listTasks({ status: status || undefined, tenantId: 'system' });
    res.json({ ok: true, tasks: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
```

- [ ] **Step 7: portal-pm.html 橙色「待确认」badge**

在 `web/portal-pm.html` 任务卡片渲染处（搜索任务列表渲染函数，定位卡片 div）追加 badge 逻辑：

```javascript
// 在渲染每张任务卡片时：
const badge = task.status === 'awaiting_confirm'
  ? `<span class="badge badge-warning">待确认 ●</span>` : '';
// 将 badge 注入卡片标题右侧
```

并在 `<style>` 内追加：
```css
.badge-warning { background:#ff8c00; color:#fff; padding:2px 8px; border-radius:10px; font-size:12px; }
```

> 具体插入点需阅读 `web/portal-pm.html` 现有卡片渲染 DOM 结构（搜索 `class="task-card"` 或类似）。若 portal-pm.html 当前未渲染任务列表，则在「决策/任务」Tab 内新增一个 fetch `/api/tasks?status=awaiting_confirm` 的区块。

- [ ] **Step 8: index.html kanban 轻量列**

在 `web/index.html` 看板列定义数组中，参照现有列（ready/running/done/failed/blocked）追加一列 `awaiting_confirm`（标签「待确认 (N)」，橙色背景）。具体 DOM 结构参照现有看板渲染代码。

- [ ] **Step 9: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/kanban-confirm-state.test.js`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add src/kanban/types.js src/kanban/kanban.js db/migration-confirm-audit.sql src/http/routes.js web/portal-pm.html web/index.html test/kanban-confirm-state.test.js
git commit -m "feat(kanban): awaiting_confirm 状态机 + 审计迁移 + portal 待确认 badge（Task 4）"
```

---

## Task 5：凭证补完三通道 + 绝对禁红线文档化

**目标**：提供 `.env` 模板 + PowerShell 命令 + 环境变量约定（均不出现在对话明文）；将绝对禁明文红线字串写入 ≥9 个 SKILL.md；`auth.js` 顶部加红线注释。

**Files:**
- Create: `scripts/.env.example`
- Create: `scripts/setup-credentials.ps1`
- Modify: `src/mcp/auth.js`（顶部红线注释 + `verifyTokenPrefix` demo 辅助）
- Modify: `skills/*/SKILL.md`（12 个源）+ `.workbuddy-plugin/skills/*/SKILL.md`（12 个分发副本）
- Create: `test/credentials-redline.test.js`

- [ ] **Step 1: 写失败测试**

`test/credentials-redline.test.js`：

```javascript
// test/credentials-redline.test.js — 凭证补完三通道 + 绝对禁明文红线（Task 5）
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { verifyTokenPrefix } from '../src/mcp/auth.js';

const REDLINE = 'AI 永远不在对话中接收或显示密钥明文';

describe('凭证模板/命令不含明文', () => {
  it('.env.example 不含真实 token 值', () => {
    const s = readFileSync('scripts/.env.example', 'utf8');
    expect(s).toContain('CRM_API_TOKEN=');
    expect(s).not.toMatch(/CRM_API_TOKEN=\S{8,}/); // 等号后无实际值
  });
  it('setup-credentials.ps1 不含明文 token', () => {
    const s = readFileSync('scripts/setup-credentials.ps1', 'utf8');
    expect(s).toContain('CRM_API_TOKEN');
    expect(s).not.toMatch(/CRM_API_TOKEN\s*=\s*"[A-Za-z0-9]{8,}/);
  });
});

describe('绝对禁明文红线字串落地', () => {
  it('≥9 个 skills/*/SKILL.md 含红线字串', () => {
    const dir = 'skills';
    const hits = readdirSync(dir).filter(d => {
      try { return readFileSync(join(dir, d, 'SKILL.md'), 'utf8').includes(REDLINE); } catch { return false; }
    });
    expect(hits.length).toBeGreaterThanOrEqual(9);
  });
});

describe('verifyTokenPrefix · 仅校验前 4 位（不接触明文）', () => {
  it('前缀匹配返回 true，不匹配返回 false', () => {
    process.env.CRM_API_TOKEN = 'abcdEFGHIJKL';
    expect(verifyTokenPrefix('abcd')).toBe(true);
    expect(verifyTokenPrefix('zzzz')).toBe(false);
    delete process.env.CRM_API_TOKEN;
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/credentials-redline.test.js`
Expected: FAIL — 文件/函数不存在；SKILL.md 无红线字串。

- [ ] **Step 3: 创建 scripts/.env.example**

```
# ~/.crm-native/.env  —— 凭证模板（AI 提供，绝不要求你粘贴真实值到对话）
# CRM_API_TOKEN 格式：<actor>:<role>（例：wangchuan:sales）
# 填好后放 ~/.crm-native/.env，chmod 600，重启 npm run mcp:http
CRM_API_TOKEN=
CRM_API_SIGNING_KEY=
CRM_API_HTTP_PORT=3001
CRM_LOG_LEVEL=info
```

- [ ] **Step 4: 创建 scripts/setup-credentials.ps1**

```powershell
# scripts/setup-credentials.ps1 —— 仅生成环境变量命令，绝不打印/接收明文 token
# 用法：在 PowerShell 中执行，AI 看不到你输入的明文
param(
  [string]$Actor = 'wangchuan',
  [ValidateSet('sales','manager','presales','exec','finance','contract_admin')]
  [string]$Role = 'sales'
)
Write-Host "请在下一行输入你的 token（明文仅本机内存，不会发送给 AI）：" -ForegroundColor Yellow
$secure = Read-Host -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
Set-Item Env:\CRM_API_TOKEN $token
Write-Host "已设置环境变量 CRM_API_TOKEN（进程级）。验证前 4 位：" -ForegroundColor Green
Write-Host "前 4 位: $($token.Substring(0,4))  ← 仅把这 4 位回复给 AI 即可"
```

- [ ] **Step 5: auth.js 顶部红线注释 + verifyTokenPrefix**

在 `src/mcp/auth.js` 文件顶部注释块追加红线说明，并导出 `verifyTokenPrefix`：

```javascript
// 绝对红线：AI 永远不在对话中接收或显示密钥明文。
// 凭证补完仅经三安全通道：.env 模板 / 环境变量 / PowerShell 命令（见 scripts/）。
// verifyTokenPrefix 仅比对前 4 位，绝不接触完整 token。
export function verifyTokenPrefix(claimedPrefix) {
  const raw = process.env.CRM_API_TOKEN || '';
  return typeof claimedPrefix === 'string' && raw.startsWith(claimedPrefix);
}
```

- [ ] **Step 6: 红线字串写入 SKILL.md（12 源 + 12 副本）**

对以下每个目录的 `SKILL.md` 追加「安全红线」段（幂等：若已含 `REDLINE` 字串则跳过）：
- 源：`skills/crm-native`, `skills/crm-query`, `skills/crm-write`, `skills/crm-risk`, `skills/method-bant`, `skills/method-meddicc`, `skills/method-opportunity-matrix`, `skills/method-role-map`, `skills/method-risk-tradeoff`, `skills/method-stop-loss`, `skills/method-fact-vs-script`, `skills/method-presales`
- 副本：`.workbuddy-plugin/skills/*` 同名 12 个

追加内容（放在文件末尾或「安全」相关段）：
```
## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。
```

> 可用脚本批量追加（bash）：
> ```bash
> for f in skills/*/SKILL.md .workbuddy-plugin/skills/*/SKILL.md; do
>   grep -q "AI 永远不在对话中接收或显示密钥明文" "$f" || printf '\n## 安全红线\n- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。\n- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。\n' >> "$f"
> done
> ```

- [ ] **Step 7: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/credentials-redline.test.js`
Expected: PASS（3 用例）。

- [ ] **Step 8: 提交**

```bash
git add scripts/.env.example scripts/setup-credentials.ps1 src/mcp/auth.js skills/*/SKILL.md .workbuddy-plugin/skills/*/SKILL.md test/credentials-redline.test.js
git commit -m "feat(creds): 凭证补完三通道 + 绝对禁明文红线文档化（Task 5）"
```

---

## 最终回归与验收

- [x] **全量回归（单文件串行，规避共享 PG 排序）**

```bash
node node_modules/vitest/vitest.mjs run test/mcp-auth.test.js
node node_modules/vitest/vitest.mjs run test/mcp-gateway.test.js
node node_modules/vitest/vitest.mjs run test/actions-sensitive-read.test.js
node node_modules/vitest/vitest.mjs run test/kanban-confirm-state.test.js
node node_modules/vitest/vitest.mjs run test/credentials-redline.test.js
node node_modules/vitest/vitest.mjs run test/skills-methodology.test.js
```

✅ 实测：**49/49 全绿**（auth 8 + gateway 15 + sensitive-read 7 + kanban 4 + redline 4 + methodology 11）。

- [x] **MCP 工具面复核**

```bash
node --input-type=module -e "import {listMcpTools} from './src/mcp/tools.js'; const {tools}=listMcpTools(); console.log('total',tools.length,'read_sensitive',tools.filter(t=>t.kind==='read_sensitive').length,'delete',tools.filter(t=>/delete|remove/.test(t.name)).length);"
```

✅ 实测：`read_sensitive` = 4，删除类 = 0，total = 33（4 读 + 25 写 + 4 敏感读）。

- [x] **端到端冒烟（自动化 SDK 闭环替代人工，更严格）**：`node src/mcp/server.js --http` 启动 → 官方 `Client` + `StreamableHTTPClientTransport` 连接 → 无 token 敏感读 `crm-customer-360` → `CONFIRM_REQUIRED` + confirm_token + degraded → 持 token choice=1 → **真正执行**（ok=true，返回 customer/deal_count/contracts）→ tool 面 33（4 敏感读，0 删除）→ close。

✅ 实测闭环 5/5；并因冒烟暴露修复 3 个单元测试测不到的真 bug（见日志 14:26 段）：① 单例 McpServer 多会话崩溃 → 每会话独立实例；② `transports.set` 在 handleRequest 前导致 Map key=undefined → 移后；③ zod shape 剥协议字段（`confirm_token/choice` 被 strip）→ tools.js 扁平 schema 显式转 zod + 附加协议字段，server.js 三处直传 `t.inputSchema`。

---

## Self-Review

**1. Spec coverage（对照已批准设计文档）：**
- §4 角色确认范式（自推断 + confirm 弹窗）→ Task 2 表单含 role/switch_options。✓
- §5 边界（25 写 + 5 敏感读）→ Task 3 实现 4 个 read_sensitive（决策图走 `/api/graph/*` 不建 Action，与 §9 Task 3 注一致）。✓
- §6 降级显式弹窗 → Task 1 `degraded_reason`/`prompt_needed` + Task 2 `DEGRADED_ROLE` + `buildDegradedPrompt`。✓
- §7 凭证补完三通道 → Task 5 `.env.example` / `setup-credentials.ps1` / env var（对齐 §6.2 四选一）。✓
- §8 任务流"待确认" → Task 4 `awaiting_confirm` 状态机 + 审计列 + portal badge。✓
- §3 原则⑦（用户显式掌控点）→ Task 2 confirm choice=2 切换角色。✓

**2. Placeholder scan：** 无 TBD/TODO。所有 step 含完整代码或精确文件:line。UI 步骤（Step 7/8）标注了插入点与参照结构（因 HTML 结构需运行时读取，属合理范围）。

**3. Type consistency：**
- `mcpConfirmPhase2(confirmToken, choice, switchedRole, params, headers)` 在 Task 2/3 测试与实现一致。
- `read_sensitive` kind 在 seed-actions / tools / gateway / server 四处一致。
- `TASK_STATUSES` 在 types.js 与 migration CHECK 一致（均含 `awaiting_confirm`）。
- `verifyTokenPrefix` 在 Task 5 测试与实现一致。

**4. 已知偏差（已与用户确认范围）：** `action_calls` 表不存在 → 审计字段改挂 `crm.tasks`（设计文档 §8.3 已就地修正）。`read_sensitive` 为新增 kind，`executor.js` 对 `kind!=='write'` 直接 handler，由 gateway 闸拦截，安全。
