# P0 闭环断点修复 实施计划（2026-09-16）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。逐 Task 实施，每 Task 一 commit。

**Goal:** 闭合 `docs/2026-09-16-four-module-claim-verification-audit.md` §6 P0 五项断点，消除 5 类假绿（F1–F5）。

**Architecture:** 全部为「接线 + 去假绿」性质的最小改动，零新增定时器、零新增粒子类型、零新增 Action、零 DELETE。回写通道复用既有 `sync-writeback-fields` Action 作为唯一落点（不造第二个写通道），自动同步路径不绕过 HITL 第 3 闸。

**Tech Stack:** Node 22 ESM + Express + PG16 + vitest 3。

**依据（已批）：** 用户 2026-09-16 显式「批准 P0」。设计输入 `docs/2026-09-15-final-design-coexistence-and-proactive.md` §T04/§T05/§6.1 A-B4/A-B5/A-B6/§9.3/§15.2。

---

## 范围与红线

| # | P0 项 | 落点 |
|---|---|---|
| P0-1 | 回写接线（L3 不可达） | `sync/writeback.js`(新) + `mount.js` + `timers.js` + `connectorRouter.js` |
| P0-2 | provider 去桩（假健康） | `sync/fxiaoke.js` + `sync/engine.js` |
| P0-3 | 播种同步配置（静默 no-op） | `db/migration-sync-config.sql`(新) + `db/migrate.js` + `scripts/seed-test-config.mjs` |
| P0-4 | MCP 装配补全（F4 复发） | `src/mcp/tools.js` |
| P0-5 | im.js 去假绿（F1） | `src/signal/delivery/im.js` |

**红线（不可越）：**
1. **不绕过 HITL**：`sync-writeback-fields` 是 `needsApproval:true`，自动同步路径**默认不传** `approvalPassed`（回写被第 3 闸拦属正确行为，计入 `conflicted` 可观测）。仅当配置 `sync-trust.writeback_auto_approved === true`（人工在配置中心开启）才放行。
2. **不新增粒子类型**：映射只声明 6 类既有类型（`CRM_ACCOUNT`/`CRM_DEAL`/`CRM_CONTRACT`/`CRM_PRODUCT`/`CRM_QUOTATION`）。
3. **默认最严**：`sync-trust.default_level = 'L1'`；`writeback_fields_whitelist = []`（空白名单 = 拒绝一切回写）；`integration-providers` 样例 `enabled:false`。
4. **禁 DELETE**：播种 `WHERE NOT EXISTS` 仅 INSERT；回写/同步仅 upsert + 软标记。
5. **不吞错**：provider 失败必须落 `sync_cursor.last_status='failed'` + `last_error`，不得记 `'ok'`。
6. **不虚构外部写**：本次不回写客户侧 CRM（provider `writeBack()` 属 S4 后续，需外部平台配合），交付的是「回写通道**可达 + 可观测 + fail-closed**」。

**明确不在本次范围（防误读）：** 投递分发器生产接线（P1-6）、拓客前台入口（P1-7）、日历 ICS（P2-9）、投标/汇报日期规则（P2-10）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/signal/delivery/im.js` | 改 | 占位分支禁止写 `status:'sent'` |
| `src/mcp/tools.js` | 改 | `buildMcpTools` 补 `seedConnectorActions()` |
| `src/sync/fxiaoke.js` | 改 | `readIncremental` 真实现 + 无凭据 fail-closed |
| `src/sync/engine.js` | 改 | 尊重 provider 失败（去假健康） |
| `src/sync/writeback.js` | **新建** | `createWritebackDispatcher`（L3 回写唯一生产实现） |
| `src/sync/mount.js` | 改 | `handleObjectChanged` 补 `callWriteback` 依赖 + L3 分支 |
| `src/scheduler/timers.js` | 改 | `runSync` deps 注入 `callWriteback` |
| `src/http/connectorRouter.js` | 改 | `doSyncEvent` deps 注入 `callWriteback` |
| `db/migration-sync-config.sql` | **新建** | 三键模板（mappings/trust/providers） |
| `db/migrate.js` | 改 | 幂等播种块（仅缺失时） |
| `scripts/seed-test-config.mjs` | 改 | 测试库 `ensureSyncConfig()` |
| 测试 ×5 | **新建** | 见各 Task |

---

## Task 1 · P0-5：im.js 去假绿

**Files:**
- Modify: `src/signal/delivery/im.js:25-33`
- Test: `test/signal/imDeliveryNoFalseGreen.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/signal/imDeliveryNoFalseGreen.test.js — P0-5：占位渠道禁止写 sent（去假绿）
// 背景：im.js 占位分支不发起任何 HTTP 却写 status:'sent' → 污染专门用于防假绿的 crm.signal_delivery 账本。
// 契约：未接入真实推送时，流水必须为 skipped + last_error='im_not_implemented'，且 delivered_at 为空。
import { describe, it, expect } from 'vitest';
import { createImProvider } from '../../src/signal/delivery/im.js';

function memStore() {
  const rows = [];
  return { rows, store: { async record(p) { rows.push(p); return p; } } };
}

describe('im 渠道占位不写 sent（P0-5 去假绿）', () => {
  it('配了 webhook 但未接真实推送 → skipped + last_error，绝不 sent', async () => {
    const { rows, store } = memStore();
    const p = createImProvider({ webhookUrl: 'https://example.invalid/hook' });
    const r = await p.send({ signal: { signal_id: 's1', tenant_id: 't1' }, deliveryStore: store });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].last_error).toBe('im_not_implemented');
    expect(r.ok).toBe(false);
  });

  it('未配 webhook → failed + im_webhook_not_configured（既有 fail-closed 不回归）', async () => {
    const { rows, store } = memStore();
    const p = createImProvider({});
    const r = await p.send({ signal: { signal_id: 's2', tenant_id: 't1' }, deliveryStore: store });
    expect(r.ok).toBe(false);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].last_error).toBe('im_webhook_not_configured');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/signal/imDeliveryNoFalseGreen.test.js`
Expected: FAIL —— 第一个用例收到 `status: 'sent'`

- [ ] **Step 3: 改实现**

`src/signal/delivery/im.js` 第 25-33 行整段替换为：

```js
      // ⚠ 去假绿（2026-09-16 P0-5）：占位分支**禁止**写 status:'sent'
      //   本渠道此刻不发起任何 HTTP（未接入钉钉/企微/飞书签名推送）。写 sent 会让
      //   crm.signal_delivery（专门用于防「投递即已完成」假绿）沉淀假账，一旦接线将掩盖未送达事实。
      //   契约：未实现 → skipped + last_error='im_not_implemented'（可被 failures() 检出 + 可重投）。
      //   真实推送接入时替换本段：签名请求 → 成功写 sent / 失败写 failed。
      await deliveryStore.record({
        signal_id: signal.signal_id,
        tenant_id: signal.tenant_id,
        channel: 'im',
        provider: 'custom',
        status: 'skipped',
        last_error: 'im_not_implemented',
      });
      return { ok: false, error: 'im_not_implemented' };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/signal/imDeliveryNoFalseGreen.test.js test/signal/delivery.test.js`
Expected: PASS（含既有 delivery.test.js 零回归）

- [ ] **Step 5: Commit**

```powershell
git add src/signal/delivery/im.js test/signal/imDeliveryNoFalseGreen.test.js
git commit -m "fix(signal): im 占位渠道禁写 sent，改 skipped+last_error（P0-5 去假绿）"
```

---

## Task 2 · P0-4：MCP 装配补 seedConnectorActions

**Files:**
- Modify: `src/mcp/tools.js:50`
- Test: `test/mcp/connectorToolsExposed.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/mcp/connectorToolsExposed.test.js — P0-4：MCP 工具面必须包含 connector 族
// 背景（F4 第三次复发）：buildMcpTools 只 seedActions+seedDiscoveryActions，
//   而 seedConnectorActions 仅在 app 进程 routes.js:616 调用 → 独立 MCP 进程（3001 / 生产 /mcp）
//   工具面无 sync-writeback-fields → 「办公智能体经 MCP 交互后写回」链路断。
import { describe, it, expect, beforeEach } from 'vitest';
import { resetRegistry, listActions } from '../../src/action/registry.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

describe('MCP 工具面含 connector 族（P0-4）', () => {
  beforeEach(() => { resetRegistry(); });

  it('buildMcpTools(seed:true) 暴露 sync-writeback-fields', () => {
    const { tools, writeTools } = buildMcpTools({ seed: true });
    const names = new Set(tools.map((t) => t.name));
    expect(listActions().some((a) => a.name === 'sync-writeback-fields')).toBe(true);
    expect(names.has('sync-writeback-fields'), 'sync-writeback-fields 应进 MCP 写面').toBe(true);
    expect(writeTools.some((t) => t.name === 'sync-writeback-fields')).toBe(true);
  });

  it('connector 族其余写 Action 同样进入工具面', () => {
    const { tools } = buildMcpTools({ seed: true });
    const names = new Set(tools.map((t) => t.name));
    for (const n of ['conn-attio-enrich-account', 'conn-zhizao-verify-account', 'conn-tender-push', 'conn-signal-lead-gen']) {
      expect(names.has(n), `${n} 应暴露`).toBe(true);
    }
  });

  it('seed:false 不注册（既有语义零回归）', () => {
    buildMcpTools({ seed: false });
    expect(listActions().some((a) => a.name === 'sync-writeback-fields')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/mcp/connectorToolsExposed.test.js`
Expected: FAIL —— `sync-writeback-fields` 不在工具面

- [ ] **Step 3: 改实现**

`src/mcp/tools.js` 第 8 行后补 import：

```js
import { seedConnectorActions } from '../connectors/connectorActions.js';
```

第 50 行：

```js
  // 2026-09-16 P0-4 修复（F4 第三次复发）：`seedActions()` 与 `seedDiscoveryActions()` 均不含
  //   connector 族（conn-*/sync-writeback-fields 由 `seedConnectorActions()` 注册，此前仅 app 进程
  //   `routes.js:616` 调用）→ 独立 MCP 进程（`npm run mcp:http|stdio`；生产 /mcp）工具面无
  //   `sync-writeback-fields`，「办公智能体经 MCP 交互后回写」永久断链。
  //   buildMcpTools 是 MCP 暴露面唯一咽喉 → 三族在此一并注册，一处修复覆盖 server.js / 校验脚本 / 探针。
  if (seed) { seedActions(); seedDiscoveryActions(); seedConnectorActions(); }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/mcp/connectorToolsExposed.test.js test/mcp/tools.test.js test/connectors.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/mcp/tools.js test/mcp/connectorToolsExposed.test.js
git commit -m "fix(mcp): buildMcpTools 补 seedConnectorActions，暴露 sync-writeback-fields（P0-4）"
```

---

## Task 3 · P0-2 上半：fxiaoke.readIncremental 去桩

**Files:**
- Modify: `src/sync/fxiaoke.js:58-64`
- Test: `test/sync/fxiaokeRead.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/sync/fxiaokeRead.test.js — P0-2：readIncremental 禁止桩返回 ok:true+rows:[]
// 官方接口形状实证：POST https://open.fxiaoke.com/cgi/crm/v2/data/query
//   body { corpAccessToken, corpId, currentOpenUserId, data:{ dataObjectApiName, search_query_info:{ limit, offset, filters:[{field_name, field_values, operator}] } } }
//   响应 { data:{ total, offset, limit, dataList[] }, errorCode, errorMessage }
import { describe, it, expect } from 'vitest';
import { createFxiaokeProvider } from '../../src/sync/fxiaoke.js';

const fullCreds = { appId: 'a', appSecret: 's', permanentCode: 'c', corpId: 'corp-1', currentOpenUserId: 'u-1' };
const authPost = async () => ({ access_token: 'tok-1', expires_in: 7200 });

describe('fxiaoke readIncremental（P0-2 去桩）', () => {
  it('无 corpId/currentOpenUserId → ok:false（不再假健康 ok:true+空行）', async () => {
    const p = createFxiaokeProvider({
      creds: { appId: 'a', appSecret: 's', permanentCode: 'c' },
      httpPost: authPost,
    });
    const r = await p.readIncremental({ object: 'AccountObj' });
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
    expect(String(r.error)).toContain('credentials_incomplete');
  });

  it('缺 object → ok:false（object_missing，不静默空转）', async () => {
    const p = createFxiaokeProvider({ creds: fullCreds, httpPost: authPost });
    const r = await p.readIncremental({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('object_missing');
  });

  it('凭据齐备 → 真实 POST /cgi/crm/v2/data/query，解析 dataList 并推进游标', async () => {
    const calls = [];
    const p = createFxiaokeProvider({
      creds: fullCreds,
      httpPost: async (url, body) => {
        calls.push({ url, body });
        if (url.endsWith('/cgi/corpAccessToken/get')) return { access_token: 'tok-1', expires_in: 7200 };
        return {
          errorCode: 0,
          data: {
            total: 2,
            dataList: [
              { _id: 'A1', name: '客户A', last_modified_time: '2026-09-01T10:00:00Z' },
              { _id: 'A2', name: '客户B', last_modified_time: '2026-09-02T10:00:00Z' },
            ],
          },
        };
      },
    });
    const r = await p.readIncremental({ object: 'AccountObj', cursor: '2026-08-31T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(2);
    expect(r.cursor).toBe('2026-09-02T10:00:00Z'); // 游标推进到本批最大 since
    const q = calls.find((c) => c.url.endsWith('/cgi/crm/v2/data/query'));
    expect(q).toBeTruthy();
    expect(q.body.corpAccessToken).toBe('tok-1');
    expect(q.body.corpId).toBe('corp-1');
    expect(q.body.currentOpenUserId).toBe('u-1');
    expect(q.body.data.dataObjectApiName).toBe('AccountObj');
    expect(q.body.data.search_query_info.filters[0]).toEqual({
      field_name: 'last_modified_time', field_values: ['2026-08-31T00:00:00Z'], operator: 'GTE',
    });
  });

  it('业务错误码非 0 → ok:false 带 errorMessage（不伪装空批）', async () => {
    const p = createFxiaokeProvider({
      creds: fullCreds,
      httpPost: async (url) => (url.endsWith('/cgi/corpAccessToken/get')
        ? { access_token: 'tok-1', expires_in: 7200 }
        : { errorCode: 10001, errorMessage: 'invalid corpAccessToken' }),
    });
    const r = await p.readIncremental({ object: 'AccountObj' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('10001');
  });

  it('HTTP 抛错 → ok:false 带原因（不静默）', async () => {
    const p = createFxiaokeProvider({
      creds: fullCreds,
      httpPost: async (url) => {
        if (url.endsWith('/cgi/corpAccessToken/get')) return { access_token: 'tok-1', expires_in: 7200 };
        throw new Error('socket hang up');
      },
    });
    const r = await p.readIncremental({ object: 'AccountObj' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('socket hang up');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/sync/fxiaokeRead.test.js`
Expected: FAIL —— 旧实现对所有输入返回 `{ ok:true, rows:[] }`

- [ ] **Step 3: 改实现**

`src/sync/fxiaoke.js` 第 58-64 行整段替换为：

```js
  // 增量读取（真实实现，2026-09-16 P0-2 去桩）
  // 官方接口（多来源实证）：POST {baseUrl}/cgi/crm/v2/data/query
  //   body { corpAccessToken, corpId, currentOpenUserId,
  //          data: { dataObjectApiName, search_query_info: { limit, offset, filters:[{field_name, field_values, operator}] } } }
  //   响应 { data: { total, offset, limit, dataList[] }, errorCode, errorMessage }
  // ⚠ 去假绿铁律：旧实现对任何输入恒返 { ok:true, rows:[], note:'...' } → engine 记 last_status='ok' +
  //   counts.read=0 →「同步在跑」与「一条都没读到」不可区分（F2）。本实现一律 fail-closed：
  //   缺 object / 缺凭据 / 业务错误码非 0 / HTTP 异常 → ok:false（由 engine 落 status='failed' 并留痕）。
  // 字段名可由接入配置覆盖：sinceField（默认 last_modified_time）/ idField 由映射层 identity 声明。
  async function readIncremental({ object, cursor, pageSize = 100 } = {}) {
    const cur = cursor || null;
    if (!object) return { ok: false, error: 'object_missing', rows: [], cursor: cur };
    // v2/data/query 除 token 外必须携带 corpId / currentOpenUserId（官方 body 必填项）
    if (!c.corpId || !c.currentOpenUserId) {
      return { ok: false, error: 'fxiaoke_credentials_incomplete: corpId/currentOpenUserId 缺失', rows: [], cursor: cur };
    }
    const auth = await corpAccessToken();
    if (!auth.ok) return { ok: false, error: auth.error, rows: [], cursor: cur };
    const post = httpPost || (async (url, payload) => {
      const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!resp.ok) throw new Error(`fxiaoke query http ${resp.status}`);
      return resp.json();
    });
    const since = c.sinceField || 'last_modified_time';
    const filters = cur ? [{ field_name: since, field_values: [cur], operator: 'GTE' }] : [];
    try {
      const j = await post(`${baseUrl}/cgi/crm/v2/data/query`, {
        corpAccessToken: auth.token,
        corpId: c.corpId,
        currentOpenUserId: c.currentOpenUserId,
        data: {
          dataObjectApiName: object,
          search_query_info: { limit: Number(pageSize) || 100, offset: 0, filters },
        },
      });
      if (j?.errorCode !== undefined && Number(j.errorCode) !== 0) {
        return { ok: false, error: `fxiaoke_error_${j.errorCode}: ${j.errorMessage || ''}`, rows: [], cursor: cur };
      }
      const rows = Array.isArray(j?.data?.dataList) ? j.data.dataList : [];
      const maxSince = rows.reduce((m, r) => {
        const v = r?.[since];
        return v && String(v) > String(m || '') ? v : m;
      }, null);
      return { ok: true, rows, cursor: maxSince || cur, total: j?.data?.total ?? rows.length };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), rows: [], cursor: cur };
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/sync/fxiaokeRead.test.js test/sync/fxiaoke.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/sync/fxiaoke.js test/sync/fxiaokeRead.test.js
git commit -m "fix(sync): fxiaoke readIncremental 去桩，真查询+v2/data/query且缺凭据 fail-closed（P0-2）"
```

---

## Task 4 · P0-2 下半：engine 尊重 provider 失败

**Files:**
- Modify: `src/sync/engine.js:15-23`
- Test: `test/sync/engineReadFailure.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/sync/engineReadFailure.test.js — P0-2：provider 失败必须留痕，不得记 ok（去假健康）
import { describe, it, expect } from 'vitest';
import { createSyncEngine } from '../../src/sync/engine.js';

function mkEngine(provider, sets) {
  return createSyncEngine({
    provider,
    mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: {}, skippedFields: [] }) },
    resolver: { upsert: async () => ({ created: true, particle_id: 'p1' }) },
    cursor: { get: async () => null, set: async (a) => { sets.push(a); } },
    trust: { level: async () => 'L2' },
  });
}

describe('engine 读入失败留痕（P0-2）', () => {
  it('provider 返 ok:false → runOnce ok:false 且 cursor.status=failed + last_error（不记 ok）', async () => {
    const sets = [];
    const r = await mkEngine({
      kind: 'fxiaoke',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => ({ ok: false, error: 'fxiaoke_credentials_incomplete', rows: [], cursor: null }),
    }, sets).runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect(r.read).toBe(0);
    expect(sets[0].status).toBe('failed');
    expect(sets[0].error).toContain('credentials_incomplete');
  });

  it('provider 抛异常 → 同样 status=failed（旧实现 .catch 吞错记 ok 已修）', async () => {
    const sets = [];
    const r = await mkEngine({
      kind: 'mock',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => { throw new Error('socket hang up'); },
    }, sets).runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect(sets[0].status).toBe('failed');
    expect(sets[0].error).toContain('socket hang up');
  });

  it('provider 返回无 ok 字段（旧契约/替身）→ 走原路径零回归', async () => {
    const sets = [];
    const r = await mkEngine({
      kind: 'mock',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => ({ rows: [{ id: 'a1', name: 'X' }], cursor: 'c2' }),
    }, sets).runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.ok).toBe(true);
    expect(r.read).toBe(1);
    expect(r.created).toBe(1);
    expect(sets[0].status).toBe('ok');
  });

  it('L1 只读路径遇 ok:false → 同样落 failed（只读不等于可假健康）', async () => {
    const sets = [];
    const engine = createSyncEngine({
      provider: { kind: 'mock', verifyAuth: async () => ({ ok: true }), readIncremental: async () => ({ ok: false, error: 'http_500' }) },
      mapping: { apply: () => ({ ok: false }) },
      resolver: { upsert: async () => { throw new Error('不应 upsert'); } },
      cursor: { get: async () => null, set: async (a) => { sets.push(a); } },
      trust: { level: async () => 'L1' },
    });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect(sets[0].status).toBe('failed');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/sync/engineReadFailure.test.js`
Expected: FAIL —— 前两个用例得到 `ok:true` + `status:'ok'`

- [ ] **Step 3: 改实现**

`src/sync/engine.js` 第 16-17 行（`const inc = ...`）替换为：

```js
    // ⚠ 去假健康（2026-09-16 P0-2）：provider 失败必须留痕并短路返回。
    //   旧实现 `.catch(() => ({ rows: [], cursor: null }))` 吞掉异常 + 不检查 `ok:false`
    //   → counts.read=0 且 last_status='ok' →「同步在跑」与「一条都没读到」不可区分（F2）。
    let inc;
    try {
      inc = await provider.readIncremental({ object, cursor: cur?.cursor_value || null });
    } catch (e) {
      inc = { ok: false, error: String(e?.message || e) };
    }
    if (inc?.ok === false) {
      const errMsg = String(inc.error || 'read_failed');
      const zero = { read: 0, created: 0, updated: 0, skipped: 0, conflicted: 0, writeback: 0 };
      // 只读路径同样落 failed：L1 也不是「可以静默失败」的理由
      await cursor.set({
        tenantId, provider: provider.kind || 'mock', object,
        counts: zero, status: 'failed', error: errMsg,
        cursor: cur?.cursor_value || null, decisionId,
      }).catch(() => {});
      return { ok: false, error: errMsg, ...zero };
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/sync/engineReadFailure.test.js test/sync/engine.test.js test/sync/writebackGate.test.js test/sync/cursor.test.js`
Expected: PASS（零回归：既有替身不返回 `ok:false`）

- [ ] **Step 5: Commit**

```powershell
git add src/sync/engine.js test/sync/engineReadFailure.test.js
git commit -m "fix(sync): engine 尊重 provider 失败，落 last_status=failed 不再假健康（P0-2）"
```

---

## Task 5 · P0-1 上半：回写派发器（新文件）

**Files:**
- Create: `src/sync/writeback.js`
- Test: `test/sync/writebackDispatcher.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/sync/writebackDispatcher.test.js — P0-1：L3 回写派发器（唯一生产实现）
// 契约：白名单空 → fail-closed 不派发；白名单有值 → 只派发 row 中命中的字段；
//       默认不传 approvalPassed（守 HITL 第 3 闸）；仅 writeback_auto_approved===true 才放行。
import { describe, it, expect, vi } from 'vitest';
import { createWritebackDispatcher } from '../../src/sync/writeback.js';

const rc = (value) => async () => ({ value });
const trustWith = (wl, auto = false) => rc({ default_level: 'L3', writeback_fields_whitelist: wl, writeback_auto_approved: auto });

describe('createWritebackDispatcher（P0-1）', () => {
  it('白名单空 → ok:false 且不调用 dispatch（fail-closed）', async () => {
    const dispatch = vi.fn();
    const wb = createWritebackDispatcher({ dispatch, readConfig: trustWith([]) });
    const r = await wb({ tenantId: 't1', object: 'account', externalId: 'E1', particleId: 'p1', row: { name: 'X' } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('writeback_whitelist_empty');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('无白名单命中字段 → ok:false（nothing_to_write）且不派发', async () => {
    const dispatch = vi.fn();
    const wb = createWritebackDispatcher({ dispatch, readConfig: trustWith(['ai_tier']) });
    const r = await wb({ tenantId: 't1', object: 'account', externalId: 'E1', particleId: 'p1', row: { name: 'X' } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('writeback_no_fields');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('命中白名单 → 以 particleId 为 account_id 派发，默认不带 approvalPassed（守第 3 闸）', async () => {
    const dispatch = vi.fn(async () => ({ ok: false, error: 'approval_required' }));
    const wb = createWritebackDispatcher({ dispatch, readConfig: trustWith(['ai_tier', 'next_action']) });
    const r = await wb({
      tenantId: 't1', object: 'account', externalId: 'E1', particleId: 'p1',
      row: { name: 'X', ai_tier: 'HIGH', next_action: '回访', secret: 'nope' }, decisionId: 'd-1',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [name, params, ctx] = dispatch.mock.calls[0];
    expect(name).toBe('sync-writeback-fields');
    expect(params.account_id).toBe('p1');
    expect(params.fields).toEqual({ ai_tier: 'HIGH', next_action: '回访' }); // 非白名单字段被剔除
    expect(ctx.decision_id).toBe('d-1');
    expect(ctx.approvalPassed).toBeUndefined(); // 默认不放行 → executor 第 3 闸拦截
    expect(r.ok).toBe(false);
    expect(r.error).toBe('approval_required');
  });

  it('writeback_auto_approved=true（人工开启）→ 传 approvalPassed 放行；成功映射 written', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, written: ['ai_tier'], denied: [] }));
    const wb = createWritebackDispatcher({ dispatch, readConfig: trustWith(['ai_tier'], true) });
    const r = await wb({ tenantId: 't1', object: 'account', externalId: 'E1', particleId: 'p1', row: { ai_tier: 'HIGH' } });
    expect(dispatch.mock.calls[0][2].approvalPassed).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.written).toEqual(['ai_tier']);
  });

  it('缺 particleId / 缺 dispatch → fail-closed', async () => {
    const wb = createWritebackDispatcher({ dispatch: vi.fn(), readConfig: trustWith(['a']) });
    expect((await wb({ tenantId: 't1', particleId: null, row: { a: 1 } })).error).toBe('particle_id_missing');
    const wb2 = createWritebackDispatcher({ readConfig: trustWith(['a']) });
    expect((await wb2({ tenantId: 't1', particleId: 'p1', row: { a: 1 } })).error).toBe('dispatch_missing');
  });

  it('dispatch 抛错 → ok:false 带原因（不吞错）', async () => {
    const wb = createWritebackDispatcher({
      dispatch: async () => { throw new Error('boom'); },
      readConfig: trustWith(['ai_tier']),
    });
    const r = await wb({ tenantId: 't1', particleId: 'p1', row: { ai_tier: 'HIGH' } });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('boom');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/sync/writebackDispatcher.test.js`
Expected: FAIL —— 模块不存在（`Cannot find module`）

- [ ] **Step 3: 新建实现**

`src/sync/writeback.js`：

```js
// src/sync/writeback.js — L3 回写派发器（同步内核 callWriteback 的唯一生产实现）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T04 + §6.1 A-B4 + §15.2
// 职责：把「判定字段」经既有 sync-writeback-fields Action 回写（白名单 + 字段级 CAS + Source 静态标记）。
//
// 为什么复用既有 Action 而不新造写通道：
//   ① T04 已定义该 Action（connectors/connectorActions.js:158）承载「白名单 + CAS + Source='crm-ai-native'」三项成功标准；
//   ② 它经写通道第 0 闸（autoDecision）+ 第 3 闸（needsApproval）→ 回写天然受 HITL 约束；
//   ③ 再造一条写路径即违反「单一写通道」红线（同 A-B3 两个同名工厂的事故同族）。
//
// 红线（不可越）：
//   ① 白名单空 → 拒绝一切回写（fail-closed，绝不「未声明即放行」）；
//   ② 自动同步路径**默认不传** approvalPassed → 回写被 executor 第 3 闸拦（approval_required），
//      engine 计入 conflicted 可观测。仅当运营在配置中心显式置 writeback_auto_approved=true
//      （人工 HITL 决定）才放行——不存在代码内的自动提权路径；
//   ③ 范围：本次**不回写客户侧 CRM**（provider 反向写需外部平台配合，属 S4 后续）。
//      本派发器交付「回写通道可达 + 可观测 + fail-closed」，落点为我方客户粒子。
export function createWritebackDispatcher({ dispatch, readConfig } = {}) {
  return async function callWriteback({
    tenantId = 'system', object, externalId, particleId, row = {}, level, decisionId = null,
  } = {}) {
    if (typeof dispatch !== 'function') return { ok: false, error: 'dispatch_missing' };
    if (!particleId) return { ok: false, error: 'particle_id_missing' };

    const trust = await (readConfig
      ? readConfig('sync-trust', { tenantId }).catch(() => null)
      : Promise.resolve(null));
    const cfg = trust?.value || {};
    const whitelist = Array.isArray(cfg.writeback_fields_whitelist) ? cfg.writeback_fields_whitelist : [];
    if (!whitelist.length) return { ok: false, error: 'writeback_whitelist_empty' };

    // 只取 row 中命中白名单且值存在的字段（非白名单字段在此剔除；Action 内会再过滤一次，双保险）
    const fields = {};
    for (const k of whitelist) {
      const v = row?.[k];
      if (v !== undefined && v !== null) fields[k] = v;
    }
    if (!Object.keys(fields).length) return { ok: false, error: 'writeback_no_fields' };

    const casExpect = row?.__cas_expect && typeof row.__cas_expect === 'object' ? row.__cas_expect : undefined;
    const params = { account_id: particleId, fields };
    if (casExpect) params.cas_expect = casExpect;

    const ctx = { actor: 'sync-engine', tenantId, decision_id: decisionId };
    // HITL 第 3 闸：默认不放行（approvalPassed 缺失 → executor 返 approval_required）
    if (cfg.writeback_auto_approved === true) ctx.approvalPassed = true;

    const r = await dispatch('sync-writeback-fields', params, ctx)
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!r?.ok) return { ok: false, error: r?.error || 'writeback_rejected', denied: r?.denied || [] };
    return { ok: true, written: r?.written || Object.keys(fields), denied: r?.denied || [], object, externalId, level };
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/sync/writebackDispatcher.test.js`
Expected: PASS（6/6）

- [ ] **Step 5: Commit**

```powershell
git add src/sync/writeback.js test/sync/writebackDispatcher.test.js
git commit -m "feat(sync): 新增 L3 回写派发器（白名单+HITL第3闸 fail-closed）（P0-1）"
```

---

## Task 6 · P0-1 下半：回写接线到三处

**Files:**
- Modify: `src/sync/mount.js:173-176, 201-211`
- Modify: `src/scheduler/timers.js:494-505`
- Modify: `src/http/connectorRouter.js:58-72`
- Test: `test/sync/mountWriteback.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/sync/mountWriteback.test.js — P0-1：handleObjectChanged 必须支持 callWriteback（L3 事件回写）
// 背景：engine.js:38 有回写分支，但 handleObjectChanged 形参不含 callWriteback 且生产两处装配均未传
//       → counts.writeback 恒 0 → L3 永远不可达。
import { describe, it, expect, vi } from 'vitest';
import { handleObjectChanged } from '../../src/sync/mount.js';

const mappings = {
  account: {
    particle_type: 'CRM_ACCOUNT',
    identity: { external_id_field: 'id' },
    fields: [{ ext: 'id', particle: 'external_id' }, { ext: 'name', particle: 'name' }],
  },
};
const rc = (v) => async () => ({ value: v });

function mkDeps(extra = {}) {
  return {
    mappings,
    readConfig: rc({ default_level: 'L3' }),
    pool: {},
    createResolver: () => ({ upsert: async () => ({ created: true, particle_id: 'p1' }) }),
    mintDecision: async () => ({ decisionId: 'd-1' }),
    emit: vi.fn(),
    ...extra,
  };
}

describe('handleObjectChanged · L3 回写接线（P0-1）', () => {
  it('L3 + 注入 callWriteback → 调用之并把结果计入返回', async () => {
    const callWriteback = vi.fn(async () => ({ ok: true, written: ['ai_tier'] }));
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'customer-crm', object: 'account',
      row: { id: 'E1', name: '客户A' }, deps: mkDeps({ callWriteback }),
    });
    expect(r.ok).toBe(true);
    expect(callWriteback).toHaveBeenCalledTimes(1);
    const arg = callWriteback.mock.calls[0][0];
    expect(arg.particleId).toBe('p1');
    expect(arg.externalId).toBe('E1');
    expect(arg.decisionId).toBe('d-1');
    expect(r.writeback).toBe(1);
    expect(r.writeback_error).toBeNull();
  });

  it('L3 但 callWriteback 拒绝 → writeback=0 且 writeback_error 留痕（不静默）', async () => {
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'customer-crm', object: 'account', row: { id: 'E1', name: 'X' },
      deps: mkDeps({ callWriteback: async () => ({ ok: false, error: 'approval_required' }) }),
    });
    expect(r.ok).toBe(true);
    expect(r.writeback).toBe(0);
    expect(r.writeback_error).toBe('approval_required');
  });

  it('L2（非 L3）不触发回写（信任分级不越权）', async () => {
    const callWriteback = vi.fn();
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'customer-crm', object: 'account', row: { id: 'E1', name: 'X' },
      deps: mkDeps({ callWriteback, readConfig: rc({ default_level: 'L2' }) }),
    });
    expect(callWriteback).not.toHaveBeenCalled();
    expect(r.writeback).toBeUndefined();
  });

  it('L3 未注入 callWriteback → 不越权、不崩（零回归）', async () => {
    const r = await handleObjectChanged({
      tenantId: 't1', provider: 'customer-crm', object: 'account', row: { id: 'E1', name: 'X' }, deps: mkDeps(),
    });
    expect(r.ok).toBe(true);
    expect(r.writeback).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/sync/mountWriteback.test.js`
Expected: FAIL —— `callWriteback` 未被调用

- [ ] **Step 3: 改实现（三处）**

**(a) `src/sync/mount.js` 第 176 行**，deps 解构补 `callWriteback`：

```js
  const { mappings = {}, readConfig, createResolver, pool, mintDecision, emit, callWriteback } = deps;
```

**(b) `src/sync/mount.js`** 在第 201-203 行 `const u = await resolver.upsert({...})` 之后、`if (emit)` 之前插入：

```js
  // P0-1（2026-09-16）：L3 回写分支。此前本函数无 callWriteback 依赖 → 事件路径的 L3 永远不可达。
  // 语义与 engine.js:38 同源：回写仅 L3；失败留痕（写 writeback_error）不静默、不阻断读入。
  let wb = null;
  if (level === 'L3' && typeof callWriteback === 'function') {
    wb = await callWriteback({
      tenantId, object, externalId: extId, particleId: u?.particle_id, row, level, decisionId,
    }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  }
```

同函数 `return` 行（原第 210 行）替换为：

```js
  return {
    ok: true, readOnly: false, created: !!u?.created, particle_id: u?.particle_id, decisionId,
    ...(level === 'L3' && typeof callWriteback === 'function'
      ? { writeback: wb?.ok ? 1 : 0, writeback_error: wb?.ok ? null : (wb?.error || null) }
      : {}),
  };
```

**(c) `src/scheduler/timers.js`** 第 488-505 行的 `runSync` 分支内，将 `runSync: mount ? async ({ tenantId, targets }) => mount.runTenantSyncOnce({...}) : undefined,` 整段替换为：

```js
        runSync: mount ? async ({ tenantId, targets }) => {
          // P0-1（2026-09-16）：L3 回写接线。此前 deps 未传 callWriteback → engine.js:38 分支恒不成立
          //   → counts.writeback 恒 0、L3 档「接线了却永不回写」。此处与 connectorRouter 同源装配。
          const wb = await import('../sync/writeback.js').catch(() => null);
          const exec = await import('../action/executor.js').catch(() => null);
          const callWriteback = (wb?.createWritebackDispatcher && exec?.actionExecutor?.dispatch)
            ? wb.createWritebackDispatcher({ dispatch: exec.actionExecutor.dispatch, readConfig })
            : undefined;
          return mount.runTenantSyncOnce({
            tenantId, targets,
            deps: {
              pool, emit, recordFailure,
              mappings: await mount.loadSyncMappings({ tenantId, readConfig }),
              callWriteback,
              // 第 0 闸：L2/L3 每 run 铸一枚决策；铸不出 → decisionId=null → 内核侧拒写（fail-closed）
              mintDecision: async (scene, ctx) => {
                const r = autonomy?.requireDecision ? await autonomy.requireDecision(scene, ctx).catch(() => null) : null;
                return { decisionId: r?.decision_id || null };
              },
            },
          });
        } : undefined,
```

**(d) `src/http/connectorRouter.js`** 第 58-71 行的 `mount.handleObjectChanged({...})` deps 段，在 `mintDecision` 前插入 `callWriteback`：

```js
    const wbMod = await import('../sync/writeback.js').catch(() => null);
    return mount.handleObjectChanged({
      ...args,
      deps: {
        readConfig: cfg.readConfig,
        pool: db.pool,
        mappings: await mount.loadSyncMappings({ tenantId: args.tenantId, readConfig: cfg.readConfig }),
        emit: bus?.emit,
        // P0-1（2026-09-16）：L3 回写接线（与 timers.js 集成轮询同源装配）
        callWriteback: wbMod?.createWritebackDispatcher
          ? wbMod.createWritebackDispatcher({ dispatch: actionExecutor.dispatch, readConfig: cfg.readConfig })
          : undefined,
        // 第 0 闸：L2/L3 写路径须铸决策；铸不出 → 内核拒写（fail-closed，与 timers.js 集成轮询同源装配）
        mintDecision: async (scene, ctx) => {
          const r = autonomy?.requireDecision ? await autonomy.requireDecision(scene, ctx).catch(() => null) : null;
          return { decisionId: r?.decision_id || null };
        },
      },
    });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/sync/mountWriteback.test.js test/sync/mount.test.js test/sync/writebackDispatcher.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/sync/mount.js src/scheduler/timers.js src/http/connectorRouter.js test/sync/mountWriteback.test.js
git commit -m "fix(sync): L3 回写接线（handleObjectChanged+timers+connectorRouter 三处装配）（P0-1）"
```

---

## Task 7 · P0-3：播种同步配置三键

**Files:**
- Create: `db/migration-sync-config.sql`
- Modify: `db/migrate.js`（在 signal-schedule 播种块后追加快照）
- Modify: `scripts/seed-test-config.mjs`（新增 `ensureSyncConfig()`）
- Test: `test/sync/syncConfigTemplate.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/sync/syncConfigTemplate.test.js — P0-3：同步配置模板静态守卫
// 价值：播种 SQL 一旦写错 particle_type（不存在于 PARTICLE_TYPES），真库会造出孤儿类型粒子
//       ——本测试在无 DB 前提下锁死「模板 ↔ 粒子模型」一致性（呼应 tier-predicate-parity 守卫范式）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PARTICLE_TYPES } from '../../src/particles/particleModel.js';
import { normalizeSyncMappings } from '../../src/sync/mount.js';

const sql = readFileSync(new URL('../../db/migration-sync-config.sql', import.meta.url), 'utf8');

function jsonForKey(key) {
  const m = sql.match(new RegExp(`SELECT 'system', '${key}', '([\\s\\S]*?)'::jsonb`));
  if (!m) throw new Error(`SQL 未找到键 ${key}`);
  return JSON.parse(m[1]);
}

describe('同步配置模板（P0-3）', () => {
  it('三键齐备且幂等（WHERE NOT EXISTS）', () => {
    for (const k of ['sync-mappings', 'sync-trust', 'integration-providers']) {
      expect(sql.includes(`'${k}'`), `${k} 应被播种`).toBe(true);
    }
    expect(sql.match(/WHERE NOT EXISTS/g)?.length).toBe(3);
    expect(sql.includes('DELETE')).toBe(false); // 禁删铁律
  });

  it('sync-mappings 覆盖 6 类对象且 particle_type 全为既有类型（防孤儿类型）', () => {
    const raw = jsonForKey('sync-mappings');
    const norm = normalizeSyncMappings(raw);
    const objects = Object.keys(norm);
    expect(objects.sort()).toEqual(['account', 'contract', 'lead', 'opportunity', 'product', 'quotation']);
    for (const [obj, def] of Object.entries(norm)) {
      expect(Object.keys(PARTICLE_TYPES), `${obj} → ${def.particle_type} 不在粒子模型`).toContain(def.particle_type);
      expect(Array.isArray(def.fields) && def.fields.length > 0, `${obj} 应有字段映射`).toBe(true);
      for (const f of def.fields) expect(typeof f.ext).toBe('string');
    }
    expect(norm.account.particle_type).toBe('CRM_ACCOUNT');
    expect(norm.contract.particle_type).toBe('CRM_CONTRACT');
    expect(norm.product.particle_type).toBe('CRM_PRODUCT');
    expect(norm.quotation.particle_type).toBe('CRM_QUOTATION');
  });

  it('sync-trust 默认最严（L1）+ 空白名单 + 不回写自动放行', () => {
    const t = jsonForKey('sync-trust');
    expect(t.default_level).toBe('L1');
    expect(t.writeback_fields_whitelist).toEqual([]);
    expect(t.writeback_auto_approved).toBe(false);
    expect(t.levels.L2.allow_writeback).toBe(false);
    expect(t.levels.L3.allow_writeback).toBe(true);
    expect(t.levels.L3.first_n_batches_require_human).toBeGreaterThan(0);
  });

  it('integration-providers 样例对象名与 mappings 键逐字一致 + enabled:false（不自动开启）', () => {
    const providers = jsonForKey('integration-providers');
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    const d = providers[0];
    expect(d.enabled).toBe(false);
    expect(d.trust_level).toBe('L1');
    const inbound = (d.objects || []).filter((o) => !o.direction || o.direction === 'in').map((o) => o.name);
    const mappingKeys = Object.keys(normalizeSyncMappings(jsonForKey('sync-mappings')));
    for (const n of inbound) expect(mappingKeys, `descriptor object ${n} 无对应映射（会全 skipped）`).toContain(n);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/sync/syncConfigTemplate.test.js`
Expected: FAIL —— SQL 文件不存在（ENOENT）

- [ ] **Step 3: 新建 SQL**

`db/migration-sync-config.sql`：

```sql
-- 外部数据接入（S2）配置模板三键（2026-09-16 P0-3）
-- (system,'sync-mappings')        = 对象↔粒子声明式映射（mapping.js 消费）
-- (system,'sync-trust')           = 信任分级 + 回写白名单（trust.js / writeback.js 消费）
-- (system,'integration-providers') = provider 描述符（mount.loadTenantSyncTargets 消费）
-- 幂等：WHERE NOT EXISTS（仅缺失时播种，绝不覆盖运营配置）；禁删铁律：仅 INSERT。
-- ⚠ enabled:false + 占位 endpoint = **模板骨架**（不是已接通）。接入客户 CRM 时必须由人工（HITL）
--   在配置中心改 enabled/endpoint/凭据，并把 objects[].name 对齐客户 CRM 真实对象 API 名。
-- ⚠ 回写白名单为空 = 拒绝一切回写（fail-closed）。启用回写前必须由人工显式声明白名单字段。
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'sync-mappings', '{
  "version": 1,
  "mappings": [
    {"object":"account","particle_type":"CRM_ACCOUNT","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"industry","particle":"industry"},
               {"external":"region","particle":"region"},{"external":"size","particle":"size"},
               {"external":"source","particle":"source"},{"external":"rating","particle":"rating"},
               {"external":"domains","particle":"domains"},{"external":"business_title","particle":"business_title"}]},
    {"object":"lead","particle_type":"CRM_DEAL","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"stage","particle":"stage"},
               {"external":"owner","particle":"owner"},{"external":"source","particle":"source"}]},
    {"object":"opportunity","particle_type":"CRM_DEAL","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"stage","particle":"stage"},
               {"external":"amount","particle":"amount"},{"external":"account_id","particle":"account_id"},
               {"external":"close_date","particle":"expected_close_date"}]},
    {"object":"contract","particle_type":"CRM_CONTRACT","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"contract_no","particle":"contract_no"},{"external":"amount","particle":"amount"},
               {"external":"start_date","particle":"start_date"},{"external":"end_date","particle":"end_date"},
               {"external":"approval_status","particle":"approval_status"}]},
    {"object":"product","particle_type":"CRM_PRODUCT","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"unit","particle":"unit"},
               {"external":"category","particle":"category"},{"external":"list_price","particle":"list_price"}]},
    {"object":"quotation","particle_type":"CRM_QUOTATION","direction":"in",
     "identity":{"external_id_field":"id"},
     "fields":[{"external":"name","particle":"name"},{"external":"amount","particle":"amount"},
               {"external":"valid_until","particle":"valid_until"},{"external":"approval_status","particle":"approval_status"}]}
  ]
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='sync-mappings');

INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'sync-trust', '{
  "version": 1,
  "default_level": "L1",
  "levels": {
    "L1": {"label":"只读观察期","allow_read":true,"allow_upsert":false,"allow_writeback":false},
    "L2": {"label":"批量入库","allow_read":true,"allow_upsert":true,"allow_writeback":false,"decision_granularity":"per_run"},
    "L3": {"label":"启用回写","allow_read":true,"allow_upsert":true,"allow_writeback":true,
           "decision_granularity":"per_run","first_n_batches_require_human":3}
  },
  "writeback_fields_whitelist": [],
  "writeback_auto_approved": false
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='sync-trust');

INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'integration-providers', '[
  {
    "id": "customer-crm",
    "kind": "generic-rest",
    "enabled": false,
    "endpoint": "https://customer-crm.invalid/api/sync",
    "token_mode": "bearer",
    "trust_level": "L1",
    "objects": [
      {"name":"account","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"lead","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"opportunity","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"contract","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"product","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"quotation","direction":"in","id_field":"id","since_field":"updated_at"},
      {"name":"account","direction":"out"}
    ]
  }
]'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='integration-providers');
```

- [ ] **Step 4: 接入 migrate.js（仅缺失时播种）**

`db/migrate.js` 在 signal-schedule 播种块之后追加：

```js
  // ─── S2 外部数据接入配置模板三键（2026-09-16 P0-3）───
  // 背景：crm_native 的 config_store 从无 sync-mappings / sync-trust / integration-providers
  //   → loadSyncMappings 返 {} → mapping.apply 恒 object_not_mapped → 全部 skipped；
  //   loadTenantSyncTargets 返 [] → 定时器「在跑但零目标」。且两处 catch 静默 → 零报错零日志（F5）。
  //   语义=初始化（WHERE NOT EXISTS），仅缺失时播种，绝不覆盖运营配置。
  try {
    const hasSync = await pool.query(
      `SELECT 1 FROM crm.config_store WHERE tenant_id='system' AND key IN ('sync-mappings','sync-trust','integration-providers') LIMIT 1`
    );
    if (!hasSync.rowCount) {
      const syncSql = readFileSync(new URL('./migration-sync-config.sql', import.meta.url), 'utf8');
      const sres = await pool.query(syncSql);
      console.log(`[migrate] 外部数据接入配置模板已播种（sync-mappings/sync-trust/integration-providers，本次新增 ${sres.rowCount ?? 0} 条）`);
    } else {
      console.log('[migrate] 外部数据接入配置已存在，跳过（不覆盖现网配置）');
    }
  } catch (e) {
    console.log('[migrate] 同步配置模板播种跳过：', String(e.message || e).slice(0, 100));
  }
```

- [ ] **Step 5: 接入测试库播种**

`scripts/seed-test-config.mjs` 新增（放在 `ensureLeadPoolConfig` 之后）：

```js
// S2 外部数据接入配置模板三键（2026-09-16 P0-3）
// 与 db/migration-sync-config.sql 同源（单一事实源）；幂等 WHERE NOT EXISTS。
async function ensureSyncConfig() {
  try {
    const has = await pool.query(
      `SELECT 1 FROM crm.config_store WHERE tenant_id='system' AND key IN ('sync-mappings','sync-trust','integration-providers') LIMIT 1`
    );
    if (has.rowCount) return;
    const sql = readFileSync(new URL('../db/migration-sync-config.sql', import.meta.url), 'utf8');
    const r = await pool.query(sql);
    console.log(`[seed-test-config] 同步配置模板已播种（${r.rowCount ?? 0} 条）`);
  } catch (e) {
    console.log('[seed-test-config] 同步配置模板播种跳过：', String(e.message || e).slice(0, 100));
  }
}
```

并在文件尾部 ensure 调用区（`await ensureLeadPoolConfig();` 之后）加：

```js
await ensureSyncConfig();
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/sync/syncConfigTemplate.test.js`
Expected: PASS

- [ ] **Step 7: 真库播种验证（本机 crm_native）**

Run: `PGDATABASE=crm_native node db/migrate.js`
Expected: 输出「外部数据接入配置模板已播种」或「已存在，跳过」

Run:
```powershell
node -e "process.env.PGDATABASE='crm_native';import('./src/db.js').then(async({pool})=>{const r=await pool.query(\"SELECT key, jsonb_typeof(value) t FROM crm.config_store WHERE key IN ('sync-mappings','sync-trust','integration-providers') ORDER BY key\");console.log(r.rows);await pool.end();})"
```
Expected: 3 行（jsonb_typeof = object/object/array）

- [ ] **Step 8: Commit**

```powershell
git add db/migration-sync-config.sql db/migrate.js scripts/seed-test-config.mjs test/sync/syncConfigTemplate.test.js
git commit -m "feat(sync): 播种 sync-mappings/sync-trust/integration-providers 三键模板（P0-3）"
```

---

## Task 8 · 回归 + 收口

- [ ] **Step 1: 全量相关回归**

Run: `npx vitest run test/sync test/signal test/mcp test/connectors test/external-integration.test.js`
Expected: 全绿。⚠ 单次红先查并行会话/共享库（共享 crm_native_test 并发 TRUNCATE → 伪失败），不得直判回归。

- [ ] **Step 2: 真库端到端（去假绿的关键一步：证明「不是只把测试改绿」）**

Run: `node scripts/verify-release-source.mjs`
Expected: 无阻断项（⚠ 该脚本盲区：SCAN_TOPS 不含 test/）

- [ ] **Step 3: 更新审计报告状态**

在 `docs/2026-09-16-four-module-claim-verification-audit.md` §6 P0 五项逐条追加「✅ 已闭环 / commit / 验证证据」。

- [ ] **Step 4: 输出分组提交命令 + 收口报告**

汇报内容：每项 P0 的 file:line 落地证据、测试结果、真库查询结果、**仍未闭合项**（回写不落客户侧 CRM、投递分发器未接线、拓客前台入口缺失、日历零实现）。

---

## Self-Review

**1. 范围覆盖**：P0-1→Task5+6；P0-2→Task3+4；P0-3→Task7；P0-4→Task2；P0-5→Task1。✅ 无遗漏。

**2. 占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。✅

**3. 类型一致性核对**：
- `createWritebackDispatcher({ dispatch, readConfig })` → Task5 定义、Task6 两处装配调用签名一致 ✅
- `callWriteback({ tenantId, object, externalId, particleId, row, level, decisionId })` → engine.js:39-42 既有调用、mount.js 新增调用、Task5 形参三处一致 ✅
- `handleObjectChanged` 返回新增 `writeback` / `writeback_error` → Task6 测试断言一致 ✅
- `readIncremental` 返回 `{ ok, rows, cursor, error?, total? }` → Task3 测试（含 `r.cursor` 断言）、Task4 engine 检查 `inc?.ok === false` 一致 ✅
- 播种 SQL 键名 `sync-mappings`/`sync-trust`/`integration-providers` → Task7 测试、Task7 migrate 块、Task7 seed 脚本、既有 `mount.js:64/75/80` 读取点五处一致 ✅
- 映射 object 名 `account/lead/opportunity/contract/product/quotation` → Task7 SQL（mappings 与 providers.objects）两处逐字一致，且由 Task7 Step1 第 4 个用例守卫 ✅

**4. 已知风险与对策**：
- ⚠ `sync-writeback-fields` 的 `needsApproval:true` → 自动路径默认 `approval_required`（这是**设计意图**，非缺陷）；验证时 `counts.conflicted` 会非 0，属预期。
- ⚠ `integration-providers` 样例 `enabled:false` → 播种后定时器仍无目标。这是刻意的 HITL 边界，Task 8 报告需明示「播种≠接通」。
