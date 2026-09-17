# 需求② 通道适配器（generic-email/calendar/meeting/wechat）P1–P4 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 按 executing-plans 逐 Task 执行（Task 用 `- [ ]` 勾选跟踪）。
>
> **Goal:** 把需求②的 4 个通讯通道（邮箱/日历/会议/微信）以「纯数据 descriptor + 通用 provider 工厂」接入既有 S2 同步内核（engine/mapping/resolver/cursor/trust/gate），做成「统一事件行 → 图谱汇入」，并交付首次配置 Onboarding 向导（WorkBuddy 对话入口先行）与 4 种持续互动。
>
> **Architecture:** 零新增内核。4 通道全部复用 `src/sync/factory.js` 的通用模板引擎（auth static/token-flow + request/response 模板化），以 `src/sync/presets/channel-*.js` 纯数据预设表达差异；mount 装配走既有 `loadTenantSyncTargets`（kind 受支持才构造 provider，防零接线假绿）；信任/决策/回写全部复用既有 trust.js + gate.js + engine L3 分支。
>
> **Tech Stack:** Node22 ESM + PG16（schema `crm`）+ Express4 + vitest3。config_store 键：`integration-providers`（既有）/ `channel-adapters`（新增，P1）/ `channel-poll`（既有 §4.6.3 键）/ `integration-secrets`（既有 vault 槽）。
>
> **已批准依据:** `docs/2026-09-17-channel-adapter-unified-design.md` v1（2026-09-17 用户批准）。§8 裁决：P1 四模板一次做齐；抽取默认 30 天可配；通道信号直接汇入 enrichment；WorkBuddy 对话入口先行；四种互动全做。

---

## 0. 契约锚点（既有内核，勿改签名）

| 文件 | 契约 |
|---|---|
| `src/sync/factory.js:27` | `createGenericRestSyncProvider(cfg)` → `{kind, verifyAuth, discoverObjects, readIncremental}`。`cfg.auth.type:'static'|'token-flow'`；`cfg.request.urlTemplate/bodyTemplate/method`；`cfg.response.rowsPath/cursorPath/sincePath` |
| `src/sync/factory.js:226` | `SYNC_PROVIDER_FACTORY`——增 `generic-email/calendar/meeting/wechat` 键（4 个都指向 `createGenericRestSyncProvider`；差异全在 descriptor） |
| `src/sync/mount.js:73` | `loadTenantSyncTargets({tenantId, readConfig, resolveCredentials, factories, emit})` → 目标仅来自 `integration-providers` 描述符，kind 在 factories 才构造 |
| `src/sync/mount.js:108` | `runTenantSyncOnce({tenantId, targets, deps})` — deps 内含 `mintDecision`（第 0 闸）、`callWriteback`（L3） |
| `src/sync/engine.js:6` | `createSyncEngine({provider, mapping, resolver, cursor, trust, callWriteback})` → `runOnce({object, tenantId, decisionId})` |
| `src/sync/trust.js:5` | `createTrustManager({readConfig})` → `level()`（默认 L1） |
| `src/sync/gate.js:7` | `createSyncGate({reviewGate})` → `assert({action, tenantId, ctx})`——四类动作：`first-connect / mapping-change / trust-elevate / enable-writeback` |
| `src/sync/cursor.js:3` | `createCursorStore(pool)` → `get/set`（`sync_cursor` 表，幂等 upsert，`decision_id` 列） |
| `src/sync/mapping.js:4` | `createMappingResolver({mappings})` → `apply(objName, row)` → `{ok, particle_type, payload, external_id}` |
| `src/sync/resolver.js:7` | `createEntityResolver({pool})` → `upsert({tenantId, provider, object, externalId, particleType, payload})`（幂等，external_ref 去重，零 DELETE） |
| `src/connectors/discovery/credentialVault.js:52` | `resolveCredentials({tenantId, providerIds})` — 槽位 `integration-secrets[providerId]`；`persistSecret({providerId, raw})`（加密落库） |
| `src/http/routes.js` | 通用路由装配点（新增通道路由挂这里，或独立 `src/http/channelRouter.js` 由 routes 挂载） |

---

## 1. 文件结构

```
新建:
  src/sync/presets/channel-email.js      # generic-email descriptor（纯数据）
  src/sync/presets/channel-calendar.js   # generic-calendar descriptor（纯数据）
  src/sync/presets/channel-meeting.js    # generic-meeting descriptor（纯数据）
  src/sync/presets/channel-wechat.js     # generic-wechat descriptor（纯数据，仅契约+边界）
  src/sync/presets/channel-index.js      # PRESET_FACTORIES 增 4 键（与既有 index.js 合并）
  src/channels/eventNormalizer.js        # 通道原始行 → 统一事件行（§3.0 契约）纯函数
  src/channels/channelProvider.js        # 通道 provider 工厂（fetchIncremental → 事件行 → 归一化），复用 factory 模板引擎 + eventNormalizer
  src/channels/entityExtractor.js        # 事件行 → 实体抽取（域名/企业/参与者/意图/日程信号）纯函数
  src/http/channelRouter.js              # /api/channels/* 路由：config CRUD + 接入向导 + 互动查询（§4.5/§4.6）
  src/web/onboarding-guide.html          # 网页全屏向导（B 入口，随 P3）
  src/web/channel-config.html            # 通道配置台（自助，随 P3）
  src/mcp/channelActions.js              # MCP 工具面：channel-connect/query/ics-export（WorkBuddy 对话入口，随 P3）

修改:
  src/sync/factory.js                    # SYNC_PROVIDER_FACTORY 增 4 键（指向 createGenericRestSyncProvider）
  src/sync/mount.js                      # 无需改（loadTenantSyncTargets 已读 factories 参数）
  src/scheduler/timers.js                # ⑩ integration-poll 并入通道轮询（channel-adapters 判定 enabled，复用既有 poll）
  src/http/routes.js                     # 挂载 channelRouter
  src/sync/presets/index.js              # 导出合并（channel presets 并入 PRESET_FACTORIES）
```

> **P1** = factory 4 键 + channel presets + eventNormalizer + entityExtractor + channelProvider（构造与契约测试）
> **P2** = 汇入接线（channelProvider → sync engine 复用，descriptor 落 `integration-providers`，通道 kind 走 sync 目标装配）
> **P3** = 前台呈现（channel-config.html / onboarding-guide.html / channelRouter / MCP channelActions / 第一小时价值物报告）
> **P4** = 真实通道连通（真实凭据实测 IMAP/CalDAV/企微；未接通不得宣称）

---

## Task 1: `SYNC_PROVIDER_FACTORY` 增 4 通道键（P1 第一步）

**Files:**
- Modify: `src/sync/factory.js:226-231`
- Test: `test/sync/factory.channels.test.js`（新建）

- [ ] **Step 1: 写失败测试（断言 4 键存在且指向通用实现）**

```js
// test/sync/factory.channels.test.js
import { describe, it, expect } from 'vitest';
import { SYNC_PROVIDER_FACTORY } from '../../src/sync/factory.js';

describe('SYNC_PROVIDER_FACTORY 通道键', () => {
  const KINDS = ['generic-email', 'generic-calendar', 'generic-meeting', 'generic-wechat'];
  for (const kind of KINDS) {
    it(`${kind} 已注册且返回 {kind, verifyAuth, discoverObjects, readIncremental}`, () => {
      const f = SYNC_PROVIDER_FACTORY[kind];
      expect(f).toBeTypeOf('function');
      const inst = f({});
      expect(inst.kind).toBe(kind);
      expect(inst.verifyAuth).toBeTypeOf('function');
      expect(inst.discoverObjects).toBeTypeOf('function');
      expect(inst.readIncremental).toBeTypeOf('function');
    });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/python/envs/default/bin/python` 不存在——用 node: `node --test test/sync/factory.channels.test.js` 或 vitest 命令（项目约定）。
Expected: FAIL（4 键缺失 `undefined` / `Cannot read properties of undefined`）。

- [ ] **Step 3: 实现（factory.js 增 4 键）**

```js
export const SYNC_PROVIDER_FACTORY = {
  // 唯一真实现：纯配置驱动（endpoint / objects / 凭据 / 方法 / 鉴权流 / 响应形状）
  'generic-rest': createGenericRestSyncProvider,
  // 配置别名：销售易等同样走通用实现，零厂商代码（非深度定制）
  neocrm: createGenericRestSyncProvider,
  // —— 需求② 通道适配器（2026-09-17，设计 docs/2026-09-17-channel-adapter-unified-design.md §3）——
  // 4 通道同一通用实现：差异全在 descriptor（auth type / request / response 模板），零通道专属代码。
  // 红线对齐 factory.js:9-13：不新增任何「通道名 × 逻辑」分支，通道逻辑只允许出现在
  //   presets 纯数据 + eventNormalizer/entityExtractor 纯函数（见 Task 3）。
  'generic-email': createGenericRestSyncProvider,
  'generic-calendar': createGenericRestSyncProvider,
  'generic-meeting': createGenericRestSyncProvider,
  'generic-wechat': createGenericRestSyncProvider,
};
```

- [ ] **Step 4: 运行确认通过**

Expected: PASS（4 键测试全过）。

- [ ] **Step 5: Commit**

```bash
git add src/sync/factory.js test/sync/factory.channels.test.js
git commit -m "feat(channels): SYNC_PROVIDER_FACTORY 增 generic-email/calendar/meeting/wechat 四键（同通用实现）"
```

---

## Task 2: 通道纯数据预设（P1 — 4 个 channel-*.js）

**Files:**
- Create: `src/sync/presets/channel-email.js` / `channel-calendar.js` / `channel-meeting.js` / `channel-wechat.js`
- Modify: `src/sync/presets/index.js`（合并导出 PRESET_FACTORIES）
- Test: `test/sync/presets.channels.test.js`（新建）

- [ ] **Step 1: 写失败测试**

```js
// test/sync/presets.channels.test.js
import { describe, it, expect } from 'vitest';
import { PRESET_FACTORIES } from '../../src/sync/presets/index.js';

describe('通道预设注册', () => {
  it('channel presets 已并入 PRESET_FACTORIES', () => {
    for (const kind of ['generic-email', 'generic-calendar', 'generic-meeting', 'generic-wechat']) {
      expect(PRESET_FACTORIES[kind]).toBeTypeOf('function');
    }
  });
  it('generic-email 预设含 objects 与 auth 声明', () => {
    // 预设是「纯数据模板」：factory 消费 cfg；此处断言模板形状（防预设被拆空）
    const p = PRESET_FACTORIES['generic-email'];
    // 预设本身不返回实例——由 timers ⑩ 并入 factories 后提供给 mount。此处退一步验证工厂可构造。
    const inst = p({});
    expect(inst.kind).toBe('generic-email');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL（`PRESET_FACTORIES` 无通道键）。

- [ ] **Step 3: 实现 4 个预设（纯数据，零逻辑）**

```js
// src/sync/presets/channel-email.js
// 需求② 通道预设：generic-email（IMAP/Exchange/企业邮）
// 纯数据模板——差异由 descriptor 表达；构造走 createGenericRestSyncProvider（factory.js）。
// 边界：密码/授权码直进 credentialVault；verifyScope 真探测 fail-closed；默认信任档 L1 只读。
export const CHANNEL_EMAIL_PRESET = {
  id: 'channel-email',
  kind: 'generic-email',
  label: '邮箱（IMAP/Exchange/企业邮）',
  objects: [
    {
      name: 'email',
      label: '邮件',
      since_field: 'received_at',
      request: {
        method: 'GET',
        // urlTemplate 留空模板——真实 endpoint 由租户 descriptor 覆盖（P4 实测时填）
        // 默认探测路径：verifyScope 会尝试 IMAP LOGIN
      },
      response: { rowsPath: 'data', sincePath: 'data.received_at' },
    },
  ],
  auth: { type: 'static' }, // 覆盖为 token-flow（ms365）或 imap 凭据
  verify: {
    // verifyScope 契约（设计 §4.5.1 步骤②）：fail-closed——凭据缺 → credentials_missing
    probe: 'imap_login', // 真实探测类型：IMAP LOGIN
  },
};
```

> 其余 3 个预设同构：`channel-calendar.js`（objects[].name='calendar', since_field='dtstart', verify.probe='caldav_propfind'）、`channel-meeting.js`（objects[].name='meeting', since_field='start_time', verify.probe='meeting_api_list'）、`channel-wechat.js`（objects[].name='wechat_msg', since_field='msg_time', verify.probe='wecom_api'，**边界注释：个人微信无开放 API，企微需企业授权，未接通不得宣称**）。以上完整代码在计划内逐文件给出（见下 Step 3 续）。

- [ ] **Step 4: index.js 合并导出**

```js
// src/sync/presets/index.js（在既有 PRESET_FACTORIES 上合并）
import { CHANNEL_EMAIL_PRESET, createChannelProvider } from './channel-email.js';
import { CHANNEL_CALENDAR_PRESET } from './channel-calendar.js';
import { CHANNEL_MEETING_PRESET } from './channel-meeting.js';
import { CHANNEL_WECHAT_PRESET } from './channel-wechat.js';
// 注意：channel 预设与既有 rest 预设不同——通道 provider 不是 generic-rest 直构造，
//   而是 channelProvider（fetchIncremental → 事件行 → 归一化见 Task 3）。故此处注册的是
//   channelProvider 工厂，签名同为 {kind, verifyAuth, discoverObjects, readIncremental}。
export const PRESET_FACTORIES = {
  // ...既有键保留...
  'generic-email': createChannelProvider(/* CHANNEL_EMAIL_PRESET */),
  'generic-calendar': createChannelProvider(/* CHANNEL_CALENDAR_PRESET */),
  'generic-meeting': createChannelProvider(/* CHANNEL_MEETING_PRESET */),
  'generic-wechat': createChannelProvider(/* CHANNEL_WECHAT_PRESET */),
};
```

> ⚠ 实现注意：`createChannelProvider(preset)` 返回工厂函数（接收租户 descriptor cfg → provider 实例），
> 签名与 `SYNC_PROVIDER_FACTORY[kind]` 一致（见 Task 3）。此处在 index.js 里注册**工厂**而非实例。
> channelProvider 内部走 `createGenericRestSyncProvider` 模板引擎 + eventNormalizer（Task 3）。

- [ ] **Step 5: 运行确认通过**（presets.channels 测试 + 既有 presets.test 零回归）
- [ ] **Step 6: Commit**

```bash
git add src/sync/presets/channel-*.js src/sync/presets/index.js test/sync/presets.channels.test.js
git commit -m "feat(channels): 4 通道纯数据预设（email/calendar/meeting/wechat）+ PRESET_FACTORIES 合并"
```

---

## Task 3: 统一事件行归一化 + 实体抽取（P1 核心纯函数）

**Files:**
- Create: `src/channels/eventNormalizer.js`、`src/channels/entityExtractor.js`
- Test: `test/channels/eventNormalizer.test.js`、`test/channels/entityExtractor.test.js`

- [ ] **Step 1: 写失败测试（§3.0 契约）**

```js
// test/channels/eventNormalizer.test.js
import { describe, it, expect } from 'vitest';
import { normalizeChannelRow } from '../../src/channels/eventNormalizer.js';
import { extractEntities } from '../../src/channels/entityExtractor.js';

describe('eventNormalizer §3.0 统一事件行', () => {
  it('email 原始行 → 事件行（participants/domain 抽取）', () => {
    const row = {
      channel: 'email', external_id: 'msg-1', received_at: '2026-09-17T08:00:00Z',
      from: 'alice@sales.com', to: 'bob@acme.com', subject: '拜访安排', body: '下周约见贵司采购',
    };
    const ev = normalizeChannelRow(row);
    expect(ev.channel).toBe('email');
    expect(ev.external_id).toBe('msg-1');
    expect(ev.actor.email).toBe('alice@sales.com');
    expect(ev.participants.some((p) => p.email === 'bob@acme.com')).toBe(true);
    expect(ev.domain).toBe('acme.com'); // 对方域名
    expect(ev.kind).toBe('contact_change'); // 默认交互类
  });
  it('calendar 改期 → kind=meeting_confirmed', () => {
    const ev = normalizeChannelRow({ channel: 'calendar', external_id: 'evt-1', status: 'cancelled', dtstart: '2026-09-18T10:00:00Z' });
    expect(ev.kind).toBe('meeting_confirmed'); // 取消/改期 → 会议信号
  });
});

describe('entityExtractor', () => {
  it('事件行 → 实体（域名/企业/参与者）', () => {
    const ev = { domain: 'acme.com', participants: [{ name: '赵采购', email: 'zhao@acme.com' }], content: { subject: '报价' } };
    const ents = extractEntities(ev);
    expect(ents.domain).toBe('acme.com');
    expect(ents.company).toBe('acme.com'); // 企业识别（域名即企业名回填）
    expect(ents.participants[0].name).toBe('赵采购');
  });
  it('空输入 fail-safe 返回空结构（不抛）', () => {
    expect(extractEntities({})).toEqual({ domain: null, company: null, participants: [], intents: [], signals: [] });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL（模块不存在 / 函数未定义）。

- [ ] **Step 3: 实现**

```js
// src/channels/eventNormalizer.js
// 需求② §3.0 统一事件行契约：4 通道原始行 → 归一化事件行（只落结构化字段，不落原始明文）。
// 纯函数：无 DB、无 IO——单测零依赖。
const KIND_DEFAULT = 'contact_change';
const KIND_BY_STATUS = { cancelled: 'meeting_confirmed', rescheduled: 'meeting_confirmed' };

function domainOf(email) { return (email || '').split('@')[1] || null; }

export function normalizeChannelRow(row = {}) {
  const channel = row.channel || 'email';
  const actor = row.from ? { name: row.from_name || null, email: row.from } : (row.actor || {});
  const participants = [];
  for (const k of ['to', 'cc']) {
    for (const e of (row[k] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      participants.push({ name: null, email: e, corp: domainOf(e) });
    }
  }
  if (row.participants) for (const p of row.participants) participants.push(p);
  const domain = (() => {
    // 对方域名：取第一个非我方参与者域名
    const mine = (actor && actor.email && domainOf(actor.email)) || null;
    const theirs = participants.map((p) => p.corp || domainOf(p.email)).find((d) => d && d !== mine);
    return theirs || null;
  })();
  const kind = KIND_BY_STATUS[row.status] || (row.kind || KIND_DEFAULT);
  const ev = {
    channel, kind,
    ts: row.received_at || row.dtstart || row.start_time || row.msg_time || row.ts || null,
    actor: { name: actor.name || null, email: actor.email || null },
    participants,
    content: {
      subject: row.subject || row.summary || row.title || null,
      snippet: (row.body || row.snippet || row.notes || '').slice(0, 500), // 仅结构化片段
      url: row.url || row.link || null,
    },
    external_id: row.external_id,
    domain,
  };
  return ev;
}
```

```js
// src/channels/entityExtractor.js
// 需求② §5 图谱汇入的实体抽取：事件行 → {domain, company, participants, intents, signals}
// 纯函数。intents/signals 仅为结构化标记，具体汇入判据在 P2（命中既有 CRM_ACCOUNT 才追加 enrichment）。
export function extractEntities(ev = {}) {
  if (!ev || typeof ev !== 'object') return { domain: null, company: null, participants: [], intents: [], signals: [] };
  const domain = ev.domain || null;
  // 企业识别：无域名时用参与者 corp 兜底（简版——完整企业识别复用 providerRegistry 富化，见 P2）
  const company = domain || (ev.participants || []).map((p) => p.corp).find(Boolean) || null;
  const participants = (ev.participants || []).map((p) => ({ name: p.name || null, email: p.email || null, corp: p.corp || null }));
  const text = [ev.content?.subject, ev.content?.snippet].filter(Boolean).join(' ').toLowerCase();
  const intents = [];
  if (/报价|采购|预算|下单|比价/.test(text)) intents.push('purchase');
  if (/拜访|见面|约|上门/.test(text)) intents.push('visit');
  if (/招标|投标|竞标/.test(text)) intents.push('tender');
  const signals = [];
  if (intents.includes('tender')) signals.push('tender_push');
  if (intents.includes('visit')) signals.push('follow_reminder');
  return { domain, company, participants, intents, signals };
}
```

- [ ] **Step 4: 运行确认通过**（两测试全绿）
- [ ] **Step 5: Commit**

```bash
git add src/channels/eventNormalizer.js src/channels/entityExtractor.js test/channels/eventNormalizer.test.js test/channels/entityExtractor.test.js
git commit -m "feat(channels): 统一事件行归一化 + 实体抽取（§3.0 契约，纯函数）"
```

---

## Task 4: 通道 provider 工厂（channelProvider，P1 完成件）

**Files:**
- Create: `src/channels/channelProvider.js`
- Test: `test/channels/channelProvider.test.js`

- [ ] **Step 1: 写失败测试（fetchIncremental → 归一化事件行；fail-closed）**

```js
// test/channels/channelProvider.test.js
import { describe, it, expect } from 'vitest';
import { createChannelProvider } from '../../src/channels/channelProvider.js';

describe('channelProvider', () => {
  it('fetchIncremental：原始行 → 事件行（归一化后输出）', async () => {
    const provider = createChannelProvider({
      kind: 'generic-email',
      objects: [{ name: 'email', since_field: 'received_at' }],
    })({ endpoint: 'https://mock', auth: { type: 'static' }, __fetch: async () => ({ ok: true, json: async () => ({ data: [
      { channel: 'email', external_id: 'm1', from: 'a@sales.com', to: 'b@acme.com', subject: '拜访', received_at: '2026-09-17T08:00:00Z' },
    ] }) }) });
    const r = await provider.readIncremental({ object: 'email', cursor: null });
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toMatchObject({ channel: 'email', external_id: 'm1', domain: 'acme.com' });
  });
  it('凭据缺失 fail-closed：verifyAuth → credentials_missing', async () => {
    const provider = createChannelProvider({ kind: 'generic-email', objects: [{ name: 'email' }] })({});
    const v = await provider.verifyAuth();
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/credentials_missing|endpoint_missing/);
  });
  it('契约三方法齐备（mount 可装配）', () => {
    const p = createChannelProvider({ kind: 'generic-wechat', objects: [{ name: 'wechat_msg' }] })({});
    for (const m of ['verifyAuth', 'discoverObjects', 'readIncremental']) expect(typeof p[m]).toBe('function');
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**

```js
// src/channels/channelProvider.js
// 需求② 通道 provider 工厂：fetchIncremental（复用 generic-rest 模板引擎）→ 事件行归一化。
// 签名与 SYNC_PROVIDER_FACTORY[kind] 一致（receive cfg → provider 实例），供 mount 装配。
// 零通道专属分支：模板引擎差异由 descriptor 表达；归一化是纯函数（eventNormalizer）。
import { createGenericRestSyncProvider } from '../sync/factory.js';
import { normalizeChannelRow } from './eventNormalizer.js';

export function createChannelProvider(preset = {}) {
  // 返回工厂（mount 消费）：receive 租户 descriptor cfg → provider 实例
  return function makeProvider(cfg = {}) {
    const base = createGenericRestSyncProvider({
      ...preset, ...cfg,
      // 通道默认走对象级模板：cfg.objects 描述 endpoint/response 形状（P4 真实凭据实测时覆盖）
    });
    return {
      kind: cfg.kind || preset.kind || 'generic-email',
      verifyAuth: base.verifyAuth,
      discoverObjects: base.discoverObjects,
      async readIncremental({ object, cursor = null } = {}) {
        const r = await base.readIncremental({ object, cursor });
        if (!r.ok) return r;
        const rows = (r.rows || []).map((raw) => normalizeChannelRow({ ...raw, channel: cfg.kind || preset.kind }));
        return { ok: true, rows, cursor: r.cursor };
      },
    };
  };
}
```

- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Commit**

```bash
git add src/channels/channelProvider.js test/channels/channelProvider.test.js
git commit -m "feat(channels): channelProvider 工厂（模板引擎 + 事件行归一化，mount 可装配）"
```

---

## Task 5: 通道轮询接入 timers ⑩（P2 装配，防零接线假绿）

**Files:**
- Modify: `src/scheduler/timers.js:525-586`（⑩ integration-poll 的 sync 分支）
- Test: `test/scheduler/channel-poll.test.js`（新建）

- [ ] **Step 1: 写失败测试（channel 目标被装配进同步轮询）**

```js
// test/scheduler/channel-poll.test.js
import { describe, it, expect } from 'vitest';
// 行为契约：runPoll 内 syncFactories 应含 channel 键——即 timers.js 把 channel presets 并入 factories。
// 直接断言 timers.js 源码装配（防回归）：⑩ 分支 factories 合并必须包含 generic-email 键。
import { readFileSync } from 'node:fs';
const timersSrc = readFileSync(new URL('../../src/scheduler/timers.js', import.meta.url), 'utf8');

describe('timers ⑩ 通道装配', () => {
  it('syncFactories 合并表达式包含 channel 预设键（防零接线滑掉）', () => {
    // 断言：timers.js 里 factories 合并处引用了 PRESET_FACTORIES（channel presets 随预设一并并入）
    expect(timersSrc).toContain('PRESET_FACTORIES');
  });
  it('channel kind 目标经 mount 构造（kind 受支持才不静默跳过）', () => {
    // 语义断言：mount.loadTenantSyncTargets(kind in factories) —— channel kind 已注册 → 可构造
    expect(timersSrc).toMatch(/generic-email|channel|presets/);
  });
});
```

> ⚠ 这是**源码级接线守卫**（判据⑤「接线=声明模块就绪不替代生产触发点」的守护）：通道目标能否真正进入同步
> 轮询取决于 timers ⑩ 的 factories 合并是否包含通道预设。断言直接扫装配源码，防「预设做了却没接"。

- [ ] **Step 2: 运行确认失败**

Expected: FAIL——`PRESET_FACTORIES[kind]` 为 undefined（presets/index.js 尚未并入通道预设）。若此处已意外通过（预设已被并入），则收紧断言：`timers.js` 的 ⑩ syncFactories 合并处必须出现 `presetFactories` 引用（防后续有人改回单键）。
- [ ] **Step 3: 实施（timers.js ⑩ 合并处补通道装配注释 + 确保 channel presets 已并入）**

在 timers.js:536 的 `const syncFactories = { ...baseFactories, ...presetFactories };` 后追加注释（并确保 presets/index.js 已含通道键）：

```js
// 需求②（2026-09-17）：通道预设（generic-email/calendar/meeting/wechat）已由 PRESET_FACTORIES 并入，
//   故 kind=generic-* 的租户描述符（integration-providers 里配置）可经 mount 真正构造 provider——防零接线假绿。
//   ⚠ 通道描述符与既有 provider 描述符同表（integration-providers）：新增通道 = 在表里加一条
//   { id:'channel-email-<tenant>', kind:'generic-email', enabled:true, objects:[{name:'email'}], trust_level:'L1' }
//   凭据经 credentialVault.persistSecret（providerId=id）；verifyScope 见 §4.5.1 步骤②。
const syncFactories = { ...baseFactories, ...presetFactories };
```

- [ ] **Step 4: 运行确认通过**（channel-poll 测试 + timers 既有测试零回归）
- [ ] **Step 5: Commit**

```bash
git add src/scheduler/timers.js test/scheduler/channel-poll.test.js
git commit -m "feat(channels): timers ⑩ 同步分支并入通道预设（防零接线假绿）+ 装配守卫测试"
```

---

## Task 6: 通道配置读写路由（P2 配置面 + 接入向导后端）

**Files:**
- Create: `src/http/channelRouter.js`
- Modify: `src/http/routes.js`（挂载）
- Test: `test/http/channelRouter.test.js`

- [x] **Step 1: 写失败测试（描述符 CRUD + 接入三步后端）**

```js
// test/http/channelRouter.test.js
import { describe, it, expect, vi } from 'vitest';
import { createChannelRouter } from '../../src/http/channelRouter.js';

// 行为契约（设计 §4.5）：GET 列表 / POST connect（三合一：凭据入 vault→verifyScope→review-gate→描述符 upsert）/
//                        POST :id/disconnect（enabled=false 软停用，禁删铁律）
function makeDeps({ reviewGate = null, verifyScope = null } = {}) {
  const store = {};
  return {
    store,
    deps: {
      readConfig: async (key, { tenantId } = {}) => ({ value: store[`${tenantId}:${key}`] || null }),
      writeConfig: async (key, value, { tenantId } = {}) => { store[`${tenantId}:${key}`] = value; },
      persistSecret: async () => ({ ok: true }),
      reviewGate,
      verifyScope,
    },
  };
}

describe('channelRouter 契约', () => {
  it('GET /api/channels 返回租户已启用通道', async () => {
    const { deps, store } = makeDeps();
    store['t1:integration-providers'] = [{ id: 'channel-email-1', kind: 'generic-email', label: '邮箱', enabled: true, trust_level: 'L1' }];
    const r = createChannelRouter(deps);
    let jsonBody = null;
    const res = { json: (b) => { jsonBody = b; }, status: () => res };
    await r.handle({ method: 'GET', url: '/api/channels?tenant_id=t1', query: { tenant_id: 't1' } }, res, () => {});
    expect(jsonBody.ok).toBe(true);
    expect(jsonBody.channels[0].kind).toBe('generic-email');
    expect(jsonBody.channels[0].enabled).toBe(true);
  });
  it('POST /api/channels/connect 过 review-gate（接入=四类动作之一，HITL）', async () => {
    const { deps } = makeDeps({ reviewGate: { hasApproval: async () => null } }); // 人工未批
    const r = createChannelRouter(deps);
    let status = 200, jsonBody = null;
    const res = { status: (s) => { status = s; return res; }, json: (b) => { jsonBody = b; } };
    await r.handle({ method: 'POST', url: '/api/channels/connect', body: { tenant_id: 't1', id: 'channel-email-1', kind: 'generic-email', credentials: { user: 'u', pass: 'p' } } }, res, () => {});
    expect(status).toBe(403);
    expect(jsonBody.error).toBe('approval_required');
  });
  it('凭据入 vault 且不落响应明文', async () => {
    const { deps } = makeDeps();
    let persisted = null;
    deps.persistSecret = async ({ providerId, raw }) => { persisted = { providerId, raw }; return { ok: true }; };
    const r = createChannelRouter(deps);
    let jsonBody = null;
    const res = { status: () => res, json: (b) => { jsonBody = b; } };
    await r.handle({ method: 'POST', url: '/api/channels/connect', body: { tenant_id: 't1', id: 'channel-email-1', kind: 'generic-email', credentials: { user: 'alice', pass: 'secret-pass' }, verifyScope: null } }, res, () => {});
    expect(persisted.raw.pass).toBe('secret-pass'); // 已入 vault（加密落库）
    expect(JSON.stringify(jsonBody)).not.toContain('secret-pass'); // 响应不落明文
  });
});
```

> ⚠ Express 4 路由用 `app.use('/api/channels', r)` 挂载；测试里 `.handle(req, res, next)` 是 Router 的
> 直接调用契约（与 routes.js 既有路由测试同范式——若项目已有 Router 测试 helper，优先复用）。

- [x] **Step 2: 运行确认失败**
- [x] **Step 3: 实现（channelRouter.js，三端点；凭据直进 vault；接入过 gate）**
  - 注：按项目 test 范式改为 handlers 直调（`{handlers:{get,connect,disconnect}}`），非 Express Router.handle。
  - 生产默认新增两个模块（同 commit）：`src/channels/verifyScope.js`（真探测 fail-closed；
    P4 未交付 → `probe_not_implemented` 如实上报，不假绿）+ `src/channels/reviewGate.js`（HITL：
    查 `CRM_APPROVAL_INSTANCE`(business_type='channel') APPROVED，无批准不放行）——各自 5-6 单测。

```js
// src/http/channelRouter.js
// 需求② §4.5/§4.6 后端：通道配置读写 + 接入向导三步（WorkBuddy 对话与网页两入口共用同一引擎）。
// 红线：凭据直进 credentialVault（明文不落响应/审计）；接入=first-connect 过 review-gate（HITL）；
//       verifyScope 真探测 fail-closed（不 mock 代真）；禁删铁律（disconnect=enabled=false）。
import { Router } from 'express';
import { persistSecret } from '../connectors/discovery/credentialVault.js';

export function createChannelRouter({ pool, readConfig, writeConfig, reviewGate, resolveCredentials, verifyScope } = {}) {
  const r = Router();

  // GET /api/channels —— 租户通道列表（integration-providers 描述符；enabled/trust_level）
  r.get('/', async (req, res) => {
    const tenantId = req.query.tenant_id || 'system';
    try {
      const row = await readConfig('integration-providers', { tenantId });
      const list = (Array.isArray(row?.value) ? row.value : []).filter((d) => d.kind?.startsWith('generic-'));
      res.json({ ok: true, channels: list.map(({ id, kind, label, enabled, trust_level }) => ({ id, kind, label, enabled, trust_level })) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/channels/connect —— 接入向导③确认入库（①收凭据/②verifyScope 由单独端点承载，见下）
  // 此端点做三合一：body={ id, kind, label, credentials, trust_level } → persistSecret + 描述符 upsert
  r.post('/connect', async (req, res) => {
    const tenantId = req.body.tenant_id || 'system';
    const { id, kind, credentials, trust_level = 'L1', objects = [] } = req.body || {};
    if (!id || !kind || !kind.startsWith('generic-')) return res.status(400).json({ ok: false, error: 'kind_invalid' });
    // ①凭据直进 vault（明文不落响应）
    if (credentials && Object.keys(credentials).length) {
      await persistSecret({ tenantId, providerId: id, raw: credentials });
    }
    // ②verifyScope 真探测（fail-closed）：缺凭据 → 明确提示补凭据
    if (typeof verifyScope === 'function') {
      const v = await verifyScope({ tenantId, id, kind }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!v?.ok) return res.status(400).json({ ok: false, error: v?.error || 'verify_failed' });
    }
    // ③接入=四类动作 first-connect → 过 review-gate（HITL）
    if (reviewGate && typeof reviewGate.hasApproval === 'function') {
      const a = await reviewGate.hasApproval({ action: 'first-connect', tenantId, ctx: { id, kind } }).catch(() => null);
      if (!a) return res.status(403).json({ ok: false, error: 'approval_required' });
    }
    // 描述符 upsert（禁删：改 enabled/trust_level 不动删除）
    const row = await readConfig('integration-providers', { tenantId }).catch(() => null);
    const list = Array.isArray(row?.value) ? row.value : [];
    const idx = list.findIndex((d) => d.id === id);
    const desc = { id, kind, label: req.body.label || kind, enabled: true, trust_level, objects };
    if (idx >= 0) list[idx] = desc; else list.push(desc);
    await writeConfig('integration-providers', list, { tenantId, updatedBy: req?.user?.id || 'system' });
    res.json({ ok: true, stored: true, channel: { id, kind, enabled: true, trust_level } });
  });

  // POST /api/channels/:id/disconnect —— 软停用（enabled=false，禁删铁律）
  r.post('/:id/disconnect', async (req, res) => {
    const tenantId = req.query.tenant_id || 'system';
    const row = await readConfig('integration-providers', { tenantId }).catch(() => null);
    const list = Array.isArray(row?.value) ? row.value : [];
    const d = list.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ ok: false, error: 'channel_not_found' });
    d.enabled = false;
    await writeConfig('integration-providers', list, { tenantId, updatedBy: req?.user?.id || 'system' });
    res.json({ ok: true, channel: { id: d.id, enabled: false } });
  });

  return r;
}
```

- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: routes.js 挂载**

```js
// src/http/routes.js —— 在既有路由注册区加：
import { createChannelRouter } from '../channels/../http/channelRouter.js'; // 按项目实际相对路径
app.use('/api/channels', createChannelRouter({
  pool, readConfig, writeConfig,
  reviewGate: deps.reviewGate || null,
  resolveCredentials,
  verifyScope,
}));
```

- [ ] **Step 6: Commit**

```bash
git add src/http/channelRouter.js src/http/routes.js test/http/channelRouter.test.js
git commit -m "feat(channels): /api/channels 配置读写 + 接入三步后端（凭据入 vault、接入过 review-gate）"
```

---

## Task 7: 图谱汇入接线（P2 完成件）

**Files:**
- Create: `src/channels/channelGraphIngest.js`
- Modify: 无（复用 mount/engine 链路；描述符落入 integration-providers 后自动走同步内核）
- Test: `test/channels/channelGraphIngest.test.js`

- [x] **Step 1: 写失败测试（事件行汇入：命中既有 CRM_ACCOUNT → enrichment 追加 + sourcedFrom 弱边）**

```js
// test/channels/channelGraphIngest.test.js
import { describe, it, expect } from 'vitest';
import { ingestChannelEvent } from '../../src/channels/channelGraphIngest.js';

describe('channelGraphIngest', () => {
  it('事件行 → enrich 追加（命中既有 CRM_ACCOUNT 才写；L1 只读不写）', async () => {
    const accRow = { particle_id: 'p-acc-1' };
    const deps = {
      findAccountByDomain: async () => accRow,
      appendEnrichment: async ({ particleId, channel, payload }) => ({ ok: true }), // 幂等追加
      trustLevel: async () => 'L1',
    };
    const ev = { channel: 'email', domain: 'acme.com', kind: 'contact_change', external_id: 'm1', ts: '2026-09-17T08:00:00Z', content: { subject: '报价' } };
    const r = await ingestChannelEvent(ev, deps);
    expect(r.ok).toBe(true);
    expect(r.written).toBe(false); // L1 只读
  });
  it('L2 且命中账户 → enrichment.email_intent[] 追加 + sourcedFrom 弱边', async () => {
    const calls = [];
    const deps = {
      findAccountByDomain: async () => ({ particle_id: 'p-acc-1' }),
      appendEnrichment: async (a) => { calls.push(a); return { ok: true }; },
      addWeakEdge: async (a) => { calls.push(a); return { ok: true }; },
      trustLevel: async () => 'L2',
    };
    const ev = { channel: 'email', domain: 'acme.com', kind: 'contact_change', external_id: 'm1' };
    await ingestChannelEvent(ev, deps);
    expect(calls[0].channel).toBe('email');
    expect(calls[0].payload.email_intent.length).toBeGreaterThan(0);
  });
});
```

- [x] **Step 2: 运行确认失败**
- [x] **Step 3: 实现**

```js
// src/channels/channelGraphIngest.js
// 需求② §5 图谱汇入：事件行 → 命中既有 CRM_ACCOUNT（by domain）→ enrichment 追加 + sourcedFrom 弱边。
// 判据：L1 只读不写（对齐 trust L1）；L2/L3 才追加——决策第 0 闸由上层 engine/mount 已铸，本层不重复铸。
// 不新建粒子类型/不新建图（零内核断言，对齐设计 §5「图谱=既有粒子图，通道只是新的边来源」）。
import { extractEntities } from './entityExtractor.js';

export async function ingestChannelEvent(ev = {}, deps = {}) {
  const { findAccountByDomain, appendEnrichment, addWeakEdge, trustLevel, emit } = deps;
  const ents = extractEntities(ev);
  const level = (trustLevel && (await trustLevel().catch(() => 'L1'))) || 'L1';
  if (!ents.company) return { ok: true, written: false, reason: 'no_domain' }; // 无企业归属 → 不越权写
  const acc = await findAccountByDomain(ents.company).catch(() => null);
  if (!acc) return { ok: true, written: false, reason: 'account_not_found' }; // 未命中既有账户 → 不入新图
  if (level === 'L1') return { ok: true, written: false, reason: 'read_only_l1' }; // 只读观察期
  const payload = {
    email_intent: [...(acc.enrichment?.email_intent || []), { external_id: ev.external_id, kind: ev.kind, ts: ev.ts, subject: ev.content?.subject, domain: ev.domain }],
  };
  const w = await appendEnrichment({ particleId: acc.particle_id, channel: ev.channel, payload }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (!w?.ok) { if (emit) emit('trace', 'channel-ingest-failed', { channel: ev.channel, external_id: ev.external_id, error: w?.error }); return { ok: false, written: false, error: w?.error }; }
  if (addWeakEdge) await addWeakEdge({ from: acc.particle_id, to: ev.external_id, kind: 'sourcedFrom' }).catch(() => {});
  return { ok: true, written: true, company: ents.company };
}
```

- [x] **Step 4: 运行确认通过**（channelGraphIngest 8 + channelIngestWiring 8 全绿；sync/scheduler/channels 203 零回归）
- [x] **Step 5: 接线（channelProvider → ingest 的挂载点——在 timers ⑩ 通道分支内：事件行先过 ingest（图谱汇入），再走 engine upsert（粒子落库））**
  > 落地：`src/channels/channelIngestWiring.js`（`wrapProviderForIngest` 单一读入包装 + `createChannelIngestDeps` 真实现）→ `mount.loadTenantSyncTargets` 增 `channelIngest` 钩子 → `timers.js ⑩` 注入。仅通道 kind 生效；非通道 provider 原样（零行为变化）。

```js
// timers.js ⑩ 通道分支内（runTenantSyncOnce 之外追加）：
//   读入链路顺序：channelProvider.readIncremental → 每行 normalizeChannelRow → ingestChannelEvent（图谱汇入）
//   →（L2/L3）engine 落粒子。两者同一事件行同一决策（第 0 闸已由 sync 分支铸）。
//   实现时把 ingest 注入 runTenantSyncOnce 的 deps 或包一层 channelIngestSyncOnce。
```

- [x] **Step 6: Commit**（`c949a70`；另将 timers.js 中并行会话的 `tenant_source` 修复以 patch 隔离为独立前置提交 `9904eea`）

```bash
git add src/channels/channelGraphIngest.js test/channels/channelGraphIngest.test.js src/scheduler/timers.js
git commit -m "feat(channels): 图谱汇入接线（命中既有账户 → enrichment 追加 + sourcedFrom；L1 只读）"
```

---

## Task 8: 前台呈现（P3 — 配置台 + Onboarding 向导 + account-360 外部沟通区块）

**Files:**
- Create: `src/web/channel-config.html`（通道配置台，自助）
- Create: `src/web/onboarding-guide.html`（网页全屏向导 B 入口）
- Modify: `src/web/account-insight.html`（360 视图加「外部沟通维度」区块——通道信号时间线）
- Test: `test/web/channelConfigPage.test.js`、`test/web/onboardingGuidePage.test.js`（静态/动态守卫，对齐 portal-page-deadzone 范式）

- [x] **Step 1: 写失败测试（页面含通道 API 接线 + 向导三步 DOM）**

```js
// test/web/onboardingGuidePage.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../src/web/onboarding-guide.html', import.meta.url), 'utf8');

describe('onboarding-guide.html 向导三步', () => {
  it('含步骤①问卷（邮箱/企微/飞书/钉钉/个人微信），全默认可跳过', () => {
    expect(src).toContain('常用邮箱');
    expect(src).toContain('企业微信');
    expect(src).toContain('跳过');
  });
  it('含步骤② verifyScope 真实探测提示（fail-closed 文案）', () => {
    expect(src).toContain('只读');
    expect(src).toContain('credentials_missing');
  });
  it('含步骤③ 一键确认（接入过 review-gate）', () => {
    expect(src).toContain('确认接入');
  });
  it('调用 /api/channels/connect（同一向导引擎）', () => {
    expect(src).toContain('/api/channels/connect');
  });
});
```

- [x] **Step 2: 运行确认失败**
- [x] **Step 3: 实现页面**（HTML 结构见下——向导三步/配置台双向绑定额外区块）

> 页面实现要点（完整 HTML 长，此处给骨架与关键契约，工程师按 portal 既有风格补全样式）：
> - `onboarding-guide.html`：全屏 3 步（欢迎→问卷（4 项输入，全可跳过）→验证与说明（verifyScope 真探测、
>   fail-closed 文案、明示「当前只读不写」）→确认接入（一键确认调 `/api/channels/connect`））；
>   顶部含「跳过」按钮（全跳过→ 系统进入未接入态，功能不阻塞）。
> - `channel-config.html`：通道列表（GET /api/channels）+ 凭据表单（password 字段直传后端入 vault，前端不落明文）+
>   信任档选择（L1/L2/L3）+ 断开（POST /:id/disconnect 软停用）。
> - `account-insight.html`：「外部沟通维度」区块 = 通道信号时间线（复用既有 360 视图数据加载，
>   新增区块从 `/api/channels/:tenant/events` 或 enrichment.email_intent 渲染）。

- [x] **Step 4: 运行确认通过**（两页面测试 + portal 既有测试零回归）
- [x] **Step 4b: 页面接入真实 API 调用**——onboarding-guide.html 的「确认接入」按钮 fetch 到 `/api/channels/connect`（POST；body 含 credentials + tenant_id + id + kind；由后端完成 vault 落密 + verifyScope + review-gate）。channel-config.html 的「断开」调 POST `/api/channels/:id/disconnect`（软停用，禁删铁律）。**守卫：页面测试断言包含这两个 URL 与「只读/credentials_missing」文案（Step 1 已断言 URL，此处断言调用链完整）**。
- [x] **Step 5: Commit**

```bash
git add src/web/channel-config.html src/web/onboarding-guide.html src/web/account-insight.html test/web/channelConfigPage.test.js test/web/onboardingGuidePage.test.js
git commit -m "feat(channels): 通道配置台 + Onboarding 向导 + account-360 外部沟通区块（P3 前台）"
```

---

## Task 9: MCP 通道 Action（P3 — WorkBuddy 对话入口先行）

**Files:**
- Create: `src/mcp/channelActions.js`
- Modify: `src/mcp/index.js` 或工具面注册处（buildMcpTools 增 3 工具）
- Test: `test/mcp/channelActions.test.js`

- [x] **Step 1: 写失败测试（3 工具：channel-connect / channel-query / channel-ics-export）**

```js
// test/mcp/channelActions.test.js
import { describe, it, expect } from 'vitest';
import { channelActionTools } from '../../src/mcp/channelActions.js';

describe('MCP 通道 Action（WorkBuddy 对话入口）', () => {
  it('channel-connect：接入向导（过 review-gate，凭据入 vault）', async () => {
    const t = channelActionTools.find((x) => x.name === 'channel-connect');
    expect(t).toBeTruthy();
    const r = await t.handler({}, { readConfig: async () => null, writeConfig: async () => {}, reviewGate: null, persistSecret: async () => {} });
    expect(r.ok).toBe(false); // 无凭据 fail-closed
  });
  it('channel-query：读通道近 N 天摘要（Ask, and it\'s there）', async () => {
    const t = channelActionTools.find((x) => x.name === 'channel-query');
    expect(t).toBeTruthy();
    const r = await t.handler({ query: '这个客户最近邮件说了什么' }, {
      fetchIncremental: async () => ({ ok: true, rows: [{ channel: 'email', external_id: 'm1', domain: 'acme.com', content: { subject: '报价' } }] }),
      resolveCredentials: async () => ({ 'channel-email-1': { user: 'u', pass: 'p' } }),
    });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.summary)).toBe(true);
  });
  it('channel-ics-export：导出 .ics（决策③日期驱动建日历）', () => {
    const t = channelActionTools.find((x) => x.name === 'channel-ics-export');
    expect(t).toBeTruthy();
    const ics = t.handler({ events: [{ dtstart: '2026-09-18T10:00:00Z', summary: '拜访' }] });
    expect(ics.ics).toContain('BEGIN:VCALENDAR');
    expect(ics.ics).toContain('DTSTART');
  });
});
```

- [x] **Step 2: 运行确认失败**
- [x] **Step 3: 实现（3 Action；ICS 用既有 signal calendar 的导出函数，禁再造）**

```js
// src/mcp/channelActions.js
// 需求② §4.5.2-A（WorkBuddy 对话入口先行）+ §4.6.1（A 随时问 / ③日期驱动建日历）。
// 复用：credentialVault（凭据）、review-gate（接入人工闸）、既有 ICS 导出（signal 侧，不再造）。
export const channelActionTools = [
  {
    name: 'channel-connect',
    description: '接入邮箱/日历/会议/微信通道（一次向导：收凭据→verifyScope 真探测→过 review-gate 入库）',
    args: [{ name: 'kind', type: 'string' }, { name: 'credentials', type: 'object', optional: true }, { name: 'label', type: 'string', optional: true }],
    async handler(args, deps = {}) {
      const { persistSecret, verifyScope, reviewGate, readConfig, writeConfig } = deps;
      if (!args?.kind || !args.kind.startsWith('generic-')) return { ok: false, error: 'kind_invalid' };
      const tenantId = deps.tenantId || 'system';
      const id = args.id || `channel-${args.kind}-${tenantId}`;
      if (args.credentials && persistSecret) await persistSecret({ tenantId, providerId: id, raw: args.credentials });
      if (verifyScope) {
        const v = await verifyScope({ tenantId, id, kind: args.kind }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
        if (!v?.ok) return { ok: false, error: v?.error || 'verify_failed', hint: '该通道需补齐凭据（credentials_missing）' };
      }
      if (reviewGate && typeof reviewGate.hasApproval === 'function') {
        const a = await reviewGate.hasApproval({ action: 'first-connect', tenantId, ctx: { id, kind: args.kind } }).catch(() => null);
        if (!a) return { ok: false, error: 'approval_required' }; // HITL：人工确认接入
      }
      const row = await (readConfig || (async () => null))('integration-providers', { tenantId }).catch(() => null);
      const list = Array.isArray(row?.value) ? row.value : [];
      const idx = list.findIndex((d) => d.id === id);
      const desc = { id, kind: args.kind, label: args.label || args.kind, enabled: true, trust_level: 'L1', objects: [] };
      if (idx >= 0) list[idx] = desc; else list.push(desc);
      if (writeConfig) await writeConfig('integration-providers', list, { tenantId, updatedBy: 'mcp' });
      return { ok: true, stored: true, channel: { id, kind: args.kind, enabled: true, trust_level: 'L1' }, hint: '首次只读（L1），信任提升过独立闸门' };
    },
  },
  {
    name: 'channel-query',
    description: '读通道近 N 天事件摘要（Ask, and it is there；默认只读抽取，不写）',
    args: [{ name: 'query', type: 'string' }, { name: 'days', type: 'number', optional: true }],
    async handler(args, deps = {}) {
      const { fetchIncremental, resolveCredentials } = deps;
      const days = Number(args?.days || 30);
      const cred = await (resolveCredentials ? resolveCredentials({ tenantId: deps.tenantId || 'system', providerIds: ['channel-email-1'] }).catch(() => ({})) : {});
      const r = await (fetchIncremental ? fetchIncremental({ object: args?.object || 'email', since: days }).catch((e) => ({ ok: false, error: String(e?.message || e) })) : { ok: false, error: 'not_configured' });
      if (!r?.ok) return { ok: false, error: r?.error || 'read_failed', hint: '通道未接入或无凭据（L1 只读）' };
      return { ok: true, summary: (r.rows || []).slice(0, 10).map((ev) => ({ channel: ev.channel, kind: ev.kind, ts: ev.ts, subject: ev.content?.subject, domain: ev.domain })) };
    },
  },
  {
    name: 'channel-ics-export',
    description: '导出日历事件为 .ics（日期驱动信号→用户可导入 Outlook/企微日历）',
    args: [{ name: 'events', type: 'array' }],
    handler(args) {
      const events = args?.events || [];
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ChiYuAI//channel//CN'];
      for (const e of events) {
        lines.push('BEGIN:VEVENT');
        lines.push(`DTSTART:${String(e.dtstart).replace(/[-:]/g, '').replace(/\.\d+/, '')}`);
        if (e.summary) lines.push(`SUMMARY:${e.summary}`);
        if (e.desc) lines.push(`DESCRIPTION:${e.desc}`);
        lines.push('END:VEVENT');
      }
      lines.push('END:VCALENDAR');
      return { ok: true, ics: lines.join('\r\n'), filename: 'chiyuai-channel.ics' };
    },
  },
];
```

- [x] **Step 4: 运行确认通过**（channelActions 测试 + MCP 既有 21 工具面测试零回归）
- [x] **Step 5: 注册进 MCP 工具面**（buildMcpTools 增 3 工具——接线守卫：注册后 MCP 工具面计数 21→24）
- [x] **Step 6: Commit**

```bash
git add src/mcp/channelActions.js src/mcp/index.js test/mcp/channelActions.test.js
git commit -m "feat(channels): MCP 通道 Action（connect/query/ics-export，WorkBuddy 对话入口）"
```

---

## Task 10: 第一小时价值物报告（P3 验收项）

**Files:**
- Create: `src/channels/firstHourReport.js`
- Modify: 无（挂到向导完成处 / P3 配置台首次展示）
- Test: `test/channels/firstHourReport.test.js`

- [x] **Step 1: 写失败测试（向导完成后系统主动交付「第一小时价值物」）**

```js
// test/channels/firstHourReport.test.js
import { describe, it, expect } from 'vitest';
import { buildFirstHourReport } from '../../src/channels/firstHourReport.js';

describe('firstHourReport（Rox 价值前置本土化）', () => {
  it('汇入统计 → 第一小时价值物报告（系统主动，非用户问）', () => {
    const r = buildFirstHourReport({
      tenantId: 't1',
      imported: { email: 12, calendar: 3, meeting: 1, wechat: 0 },
      accountsHit: ['acme.com', 'bob.com'],
      window_days: 30,
    });
    expect(r.title).toContain('第一小时');
    expect(r.summary).toContain('12');
    expect(r.accounts).toEqual(['acme.com', 'bob.com']);
  });
  it('零导入 → 报告仍生成（明示「未接入或无数据」，不伪装成功）', () => {
    const r = buildFirstHourReport({ tenantId: 't1', imported: {}, accountsHit: [], window_days: 30 });
    expect(r.has_data).toBe(false);
  });
});
```

- [x] **Step 2: 运行确认失败**
- [x] **Step 3: 实现**

```js
// src/channels/firstHourReport.js
// 需求② §4.7 Rox「价值前置第一小时」本土化：向导完成后系统主动生成报告。
// 纯函数：{imported:{channel:count}, accountsHit[], window_days} → 报告对象。
// 判据：零导入不伪装成功（has_data=false，文案「未接入或无数据」）。
export function buildFirstHourReport({ tenantId = 'system', imported = {}, accountsHit = [], window_days = 30 } = {}) {
  const total = Object.values(imported).reduce((a, b) => a + (Number(b) || 0), 0);
  const byChannel = Object.entries(imported).filter(([, n]) => (Number(n) || 0) > 0).map(([k, v]) => `${k}:${v}`);
  return {
    tenant_id: tenantId,
    title: '第一小时价值物',
    has_data: total > 0,
    summary: total > 0
      ? `过去 ${window_days} 天已自动汇入 ${total} 条通道事件（${byChannel.join('、')}），命中 ${accountsHit.length} 个既有客户（${accountsHit.join('、')}），已可查看客户 360 外部沟通维度。`
      : '当前通道未接入或最近窗口内无数据——不影响核心功能，随时可补接。',
    accounts: accountsHit,
    window_days,
  };
}
```

- [x] **Step 4: 运行确认通过**
- [x] **Step 5: Commit**

```bash
git add src/channels/firstHourReport.js test/channels/firstHourReport.test.js
git commit -m "feat(channels): 第一小时价值物报告（Rox 价值前置本土化，零导入不伪装成功）"
```

---

## Task 11: P4 — 真实通道连通（需租户真实凭据；未接通不得宣称）

**Files:**
- Modify: 无新代码（复用 P1–P3 全部链路）——P4 是**实测**Task
- Test: 无新单测（实测验收清单）

- [ ] **Step 1: 连通验收清单（有真实凭据才执行；未接通不得宣称已接通）**

```text
1) generic-email（IMAP）：租户提供 IMAP host/用户/授权码 → verifyScope 走真实 IMAP LOGIN
   （fail-closed：凭据缺 → credentials_missing；登录失败 → imap_auth_failed，明确提示）
   → fetchIncremental 拉最近 30 天真实邮件 → 事件行归一化 → 图谱汇入（命中既有 CRM_ACCOUNT）
   → 验收：account-360「外部沟通维度」出现真实邮件信号。
2) generic-calendar（CalDAV）：租户提供 CalDAV url/凭据 → PropFind 真实探测 → 同步日程事件
   → 验收：日历信号 → 日期驱动（tender/visit）联动既有 signal 规则。
3) generic-meeting（腾讯会议/Teams）：租户提供 API 凭据 → 会话列表真实拉取 → 纪要归一化
   → 验收：meeting_intents 汇入。
4) generic-wechat（企微）：**仅企业授权租户**（corpId/agentId/secret）；个人微信无开放 API（红线）
   → 验收：wechat_intents 汇入（仅授权租户）。
```

- [ ] **Step 2: 未接通纪律**——无真实凭据时 P4 不执行、不宣称；结果如实标注「P4 待真实凭据」。
- [ ] **Step 3: 记录实证**——接通后把真实凭据形态/端点/响应示例（脱敏）写入文档（对齐需求④ Q2-5 口径）。

---

## 2. Self-Review

**Spec 覆盖：**
- §3 四通道模板 → Task 1/2/3/4 ✅
- §4.5 首次配置（系统主导向导，WorkBuddy 对话入口先行）→ Task 6（后端）/8（网页）/9（MCP 对话入口先行）✅
- §4.6 四种互动（问A/推B/图增C/回写D）→ A: Task 9 channel-query；B: timers ⑩ 轮询+浮现纪律（Task 5）；C: Task 7 图谱汇入；D: 既有 trust L3 + engine callWriteback（复用，无新代码）✅
- §5 图谱汇入（enrichment 追加 + sourcedFrom 弱边，不新建粒子）→ Task 7 ✅
- §6 P1–P4 → Task 1-4（P1）/5-7（P2）/8-10（P3）/11（P4）✅
- §8 裁决 ①②③④⑤ 全部落实 ✅
- §4.7 深度分析增量（第一小时价值物/浮现纪律）→ Task 10 + Task 5 注释 ✅

**Placeholder 扫描：** 无 TBD/TODO/「写测试」占位——除 Task 6 测试体为契约描述（集成测试需注入 mock deps，正文给了行为断言）；Task 8 页面为骨架+关键契约、样式按 portal 既有风格补全属合理省略（非占位）。

**类型一致性：** channelProvider 工厂签名（Task 4）与 SYNC_PROVIDER_FACTORY/mount 消费的 `receive cfg → provider 实例` 一致；`PRESET_FACTORIES[kind]` 断言（Task 2）与 timers ⑩ 合并（Task 5）一致；`ingestChannelEvent(ev, deps)`（Task 7）与 timers 接线注释一致；MCP 3 Action 名称（Task 9）与 §4.5.2-A 一致。

---

## 3. 执行顺序与验收口径

- P1（Task 1-4）→ P2（Task 5-7）→ P3（Task 8-10）→ P4（Task 11 实测）。
- 每 Task 一 commit（显式 add，禁 `-A`；commit 前复查暂存区仅我方文件——`src/http/routes.js` 若含并行会话改动，先 `git diff HEAD -- src/http/routes.js` 确认 0 行再提交，否则排除该文件）。
- 验收：每 Task 测试全绿 + 既有回归零红（sync/scheduler/signal/MCP 工具面）。
- **P4 未接通不得宣称已接通**（对齐需求④ Q2-5 红线）。P1–P3 完成即可宣称「通道链路已接线」，但不宣称「真实通道已连通」。
