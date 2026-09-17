// D1 同族遗漏 P-2 护栏（2026-09-16）：观测巡检的候选租户集**不得排除平台租户 `system`**
//
// 背景：设计 §3.1.1 的 D1 修正已在泵侧落地（`src/signal/dispatcher.js` 的 `pumpAllTenants`，
//   注释明写「不得排除 system —— 平台级信号同样必须被泵」），并在 `test/signal/dispatcher.test.js`
//   留下负向断言。但**同族断点的第二处漏改**：`createSignalObservabilitySweep().sweepOnce()`
//   仍以 `WHERE tenant_id <> 'system'` 取候选集 ⇒ 平台租户被排除在扫描面外 ⇒
//   「平台级信号被泵出去了、却永不接受负向判据检查」。出口通了、观测瞎了。
//
// 隔离纪律（对齐 shared-db-test-hygiene §1.1）：本文件 **vi.mock 掉 db.js / configStore.js**，
//   → 不触库、不读项目根 `.env`、不受共享库残留态与其他文件的并发干扰；可单独裸跑，可批量跑。
//   本文件**刻意不复用真实库**：该断言是关于「传给 query 的 SQL 形状」与「扫描面包含谁」的，
//   用真实库反而会引入「库里恰好没有 system 信号」这类假绿（0 行让一切断言都"通过"）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../../src/db.js', () => ({
  query: queryMock,
  queryWrite: queryMock,
}));
// 判据 A 的渠道集合来自 config_store['signal-delivery']（Q1-4 修正）；此处注入确定值，
// 避免依赖真实配置行（且顺带屏蔽 readConfig → 真实库的隐式通路）。
vi.mock('../../src/config/configStore.js', () => ({
  readConfig: vi.fn(async () => ({ value: { channels: { inbox: 'on' } } })),
}));

import { createSignalObservabilitySweep } from '../../src/monitor/signalMetrics.js';
import { listAlerts, resetAlertStore } from '../../src/alerts/alertStore.js';

// 按 SQL 形状路由：只回本用例需要的最小事实，其余一律空行。
// 同时把「以 tenant_id=$1 被查询过的租户」记入 scanned —— 这是「谁真的进了扫描面」的**行为证据**，
// 比断言 SQL 字符串更抗改写（不依赖谓词的具体拼法）。
//
// ⚠⚠ 候选集替身必须**尊重 WHERE 子句**（本文件最重要的一处设计）：
//   起初替身写成「看到 SELECT DISTINCT tenant_id 就固定返回 [{tenant_id:'system'}]」——
//   那是 `mount.test.js` 假 deps 的同族错误：**替身的缺省值反向定义了契约**。
//   实测代价：把缺陷（`<> 'system'`）注回去后，三条"行为断言"**全绿**，只有负向 SQL 断言变红
//   ⇒ 行为断言在该缺陷下**无鉴别力**，是假绿载体。
//   现改为：候选 SQL 里**只要出现 `'system'` 字面量就视为已过滤掉系统租户**（保守模型）。
//   之所以用「出现字面量」而非「匹配具体排除写法」：前者不依赖拼法枚举，
//   能同时覆盖 `<>` / `!=` / `NOT IN` / `NOT(...)` / 子查询 等任意写法（更不容易漏）。
//   该过滤是注释无关的——sweepOnce 传给 query 的是无注释的纯 SQL 串。
function candidateTenants(sql, tenants) {
  const sysExcluded = /'system'/.test(sql);
  return tenants.filter((t) => !(sysExcluded && t === 'system'));
}

function makeQuery({ tenants = [], signalCount = 0, eventTrigger = 0, landed = 0, delivery = [] } = {}) {
  const scanned = [];
  const impl = async (sql, params) => {
    if (/SELECT DISTINCT tenant_id/.test(sql)) {
      return { rows: candidateTenants(sql, tenants).map((t) => ({ tenant_id: t })) };
    }
    if (/tenant_id=\$1/.test(sql)) scanned.push(params?.[0]);
    if (/source='event-trigger'/.test(sql)) return { rows: [{ c: eventTrigger }] };
    if (/source IN \('rule-scan','agent-research','external'\)/.test(sql)) return { rows: [{ c: landed }] };
    if (/FROM crm\.signal_delivery/.test(sql)) {
      // ⚠ F-6(a)（2026-09-16）：替身形状必须与**当前实现同源**。实现按 status 分列读
      //   `sent` / `attempted`，并在「存在零 sent 渠道」时**另发一条**「非 sent 且 last_error 非空」
      //   的查询取首位原因。旧替身形状 `{channel, c}`（只有渠道与行数）会让新实现把
      //   「有 2 条投递行」读成 `sent=undefined→0` ⇒ **凭空多报** delivery_silent ⇒ 假红。
      //   这是「替身形状掩盖缺陷」的镜像形态：**替身陈旧同样让判据失真**（两个方向都错）。
      //   下方自检用例把该形状的鉴别力钉住，防止再次退化。
      if (/last_error IS NOT NULL/.test(sql)) return { rows: delivery.filter((d) => d.last_error) };
      return { rows: delivery };
    }
    if (/AS c FROM crm\.signal/.test(sql)) return { rows: [{ c: signalCount }] };
    return { rows: [] };
  };
  return { impl, scanned };
}

beforeEach(() => {
  queryMock.mockReset();
  resetAlertStore();
});

describe('替身模型自检（防护栏自身退化为假绿）', () => {
  // 「变异验证自身需验证」：若哪天有人把候选集替身改回固定返回，负向 SQL 断言仍会红，
  // 但三条行为断言会静默失去鉴别力。此块把替身的鉴别力**显式钉住**。
  it('候选集替身对任意排除写法都能剔除 system（否则行为断言无鉴别力）', () => {
    const T = ['acme-demo', 'system'];
    const forms = [
      `SELECT DISTINCT tenant_id FROM crm.signal WHERE tenant_id <> 'system'`,
      `SELECT DISTINCT tenant_id FROM crm.signal WHERE tenant_id != 'system'`,
      `SELECT DISTINCT tenant_id FROM crm.signal WHERE tenant_id NOT IN ('system')`,
      `SELECT DISTINCT tenant_id FROM crm.signal WHERE NOT (tenant_id = 'system')`,
      `SELECT DISTINCT tenant_id FROM crm.signal WHERE tenant_id = ANY(ARRAY['system']) IS NOT TRUE`,
    ];
    for (const sql of forms) expect(candidateTenants(sql, T)).toEqual(['acme-demo']);
    // 修复后的真实 SQL（不含 'system' 字面量）→ 系统租户必须留下
    expect(candidateTenants(`SELECT DISTINCT tenant_id FROM crm.signal`, T)).toEqual(T);
  });

  // F-6(a)（2026-09-16）：替身形状必须让「零 sent 但有尝试」可表达，否则该形态无法被断言覆盖。
  it('F-6(a)：渠道有尝试但零 sent → 产出 delivery_undelivered（非 silent）；修正前该形态零告警', async () => {
    const { impl } = makeQuery({
      tenants: ['probe-f6a'], signalCount: 2, eventTrigger: 3, landed: 3, // landed=3 → 隔离 gen_silent
      delivery: [{ channel: 'inbox', sent: 0, attempted: 2, last_error: 'no_recipient' }],
    });
    queryMock.mockImplementation(impl);

    await createSignalObservabilitySweep({ windowHours: 1 }).sweepOnce();
    const alerts = listAlerts({ kind: 'signal-observability' });
    const preds = alerts.map((a) => a.payload.predicate);

    // ⚠ 鉴别力所在：修正前判据只看「该渠道有没有行」——inbox 有 2 行 ⇒ 判**健康** ⇒ 本断言会红。
    expect(preds).toContain('delivery_undelivered');
    // 有尝试 ⇒ 不属于「真静默」（静默的定义是连失败原因都没有）
    expect(preds).not.toContain('delivery_silent');
    expect(alerts.find((a) => a.payload.predicate === 'delivery_undelivered').tenant_id).toBe('probe-f6a');
  });
});

describe('createSignalObservabilitySweep — D1 同族遗漏 P-2（扫描面含平台租户）', () => {
  it('负向：候选租户集 SQL 不得以任何形式排除 system', async () => {
    queryMock.mockImplementation(async () => ({ rows: [] }));
    const sweep = createSignalObservabilitySweep({ windowHours: 1 });
    await sweep.sweepOnce();

    const candidateSql = queryMock.mock.calls.map(([sql]) => sql).find((s) => /SELECT DISTINCT tenant_id/.test(s));
    expect(candidateSql).toBeTruthy();

    // ⚠ 守卫方式说明（承 pump 侧同款教训）：**不可**用「grep 源文件禁用该串」做守卫 ——
    //   signalMetrics.js 的注释里就写着「不得排除 system」的说明文字，grep 会命中注释产生假红
    //   （代码注释写得越清楚越红）。唯一正确的守卫是对**实际传给 query 的 SQL 字符串**断言。
    expect(candidateSql).not.toMatch(/tenant_id\s*<>\s*'system'/);
    expect(candidateSql).not.toMatch(/tenant_id\s*!=\s*'system'/);
    expect(candidateSql).not.toMatch(/tenant_id\s+NOT\s+IN\s*\(\s*'system'\s*\)/i);
    expect(candidateSql).not.toMatch(/NOT\s*\(\s*tenant_id\s*=\s*'system'\s*\)/i);
  });

  it('正向：system 租户确实进入扫描面，并产出归属 system 的告警（平台告警不得静默）', async () => {
    const { impl, scanned } = makeQuery({
      tenants: ['system'], signalCount: 2, eventTrigger: 3, landed: 0, delivery: [{ channel: 'inbox', sent: 2, attempted: 2 }],
    });
    queryMock.mockImplementation(impl);

    const sweep = createSignalObservabilitySweep({ windowHours: 1 });
    const r = await sweep.sweepOnce();

    expect(r.tenants).toBe(1);
    expect(scanned).toContain('system');
    expect(r.fired).toBe(1);

    const sysAlert = listAlerts({ kind: 'signal-observability' }).find((a) => a.tenant_id === 'system');
    expect(sysAlert).toBeTruthy();
    expect(sysAlert.payload.predicate).toBe('gen_silent');
    expect(sysAlert.target_role).toBe('ops');
  });

  it('边界：平台租户零信号时自然空转（不产生告警，即修复不引入噪音）', async () => {
    const { impl } = makeQuery({ tenants: ['system'], signalCount: 0, eventTrigger: 0 });
    queryMock.mockImplementation(impl);

    const sweep = createSignalObservabilitySweep({ windowHours: 1 });
    const r = await sweep.sweepOnce();

    expect(r.tenants).toBe(1);
    expect(r.fired).toBe(0);
    expect(listAlerts({ kind: 'signal-observability' })).toHaveLength(0);
  });

  it('边界：多租户混合时平台租户与业务租户同等对待（不因租户名差别处理）', async () => {
    const { impl, scanned } = makeQuery({
      tenants: ['acme-demo', 'system'], signalCount: 2, eventTrigger: 3, landed: 0, delivery: [{ channel: 'inbox', sent: 2, attempted: 2 }],
    });
    queryMock.mockImplementation(impl);

    const sweep = createSignalObservabilitySweep({ windowHours: 1 });
    const r = await sweep.sweepOnce();

    expect(new Set(scanned)).toEqual(new Set(['acme-demo', 'system']));
    expect(r.fired).toBe(2);
    expect(listAlerts({ kind: 'signal-observability' }).map((a) => a.tenant_id).sort())
      .toEqual(['acme-demo', 'system']);
  });
});
