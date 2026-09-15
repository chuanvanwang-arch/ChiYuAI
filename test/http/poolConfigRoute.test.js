// test/http/poolConfigRoute.test.js — /api/pool-config 端点形态守护（T5 收口，本会话补）
// 背景：T5（2026-09-11 并行落地）把池配置真源迁 crm.config_store['lead-pool-config']，
//   GET → { orgId, tenantId, config, legacy, seeded }；PUT 支持 pools[]（按池 id 合并经
//   validatePoolPatch 白名单+边界校验后写 writePoolConfig）与旧 patch 形态（setPoolConfig）。
// 纯函数层（validatePoolPatch/renderPoolTabs）已被 test/portal/poolConfigRender.test.js 覆盖；
//   但**端点层（GET 三键契约 + PUT pools 合并写回 + 未知键 400）零守卫**——且该端点需真 DB，
//   PG 不可用时整面漏网（对齐 anti-fake-green-probe：接线断言必须零 DB 可跑）。
// 本用例：vi.mock 整个 src/sales/pool.js（readPoolConfig/writePoolConfig/getPoolConfig/setPoolConfig 全 stub），
//   零 DB 下断言「路由把租户解析结果透传给 readPoolConfig」+「PUT pools 合并经校验写入」+「patch 旧形态走 setPoolConfig」。
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => ({
  readPoolConfig: vi.fn(),
  writePoolConfig: vi.fn(),
  getPoolConfig: vi.fn(),
  setPoolConfig: vi.fn(),
}));

vi.mock('../../src/sales/pool.js', () => ({
  readPoolConfig: H.readPoolConfig,
  writePoolConfig: H.writePoolConfig,
  getPoolConfig: H.getPoolConfig,
  setPoolConfig: H.setPoolConfig,
  POOL_CONFIG_KEY: 'lead-pool-config',
}));

let app;
let token;
beforeAll(async () => {
  const { createApp } = await import('../../src/http/server.js');
  const { issueToken } = await import('../../src/http/auth.js');
  app = createApp();
  token = issueToken({ username: 't-pool-admin', role: 'admin', display_name: '池配置测试管理员' });
});

const TPL = {
  version: 1,
  default_pool: 'pool-new',
  pools: [
    { id: 'pool-new', type: 'new', label: '新线索公海', enabled: true,
      pick_rule: { daily_limit: 10, prev_owner_only: false, pick_interval_hours: 24, new_data_only: true },
      recycle_rule: { recycle_days: 30, recycle_target: 'self' } },
    { id: 'pool-nurture', type: 'nurture', label: '培育公海', enabled: true,
      pick_rule: { daily_limit: 5, prev_owner_only: true, pick_interval_hours: 24, new_data_only: false },
      recycle_rule: { recycle_days: 90, recycle_target: 'pool-new' } },
  ],
};

beforeEach(() => {
  // ⚠ 必须清调用记录：vi.fn() 的 mock.calls 跨用例累积，否则「not.toHaveBeenCalled」
  //   断言会看到前一用例的调用（本例「合并写回」先调了 writePoolConfig → 后两用例假失败）。
  vi.clearAllMocks();
  H.readPoolConfig.mockResolvedValue(TPL);
  H.writePoolConfig.mockResolvedValue({ ...TPL, updated_at: new Date().toISOString() });
  H.getPoolConfig.mockResolvedValue({ pick_rule: {}, recycle_rule: {} });
  H.setPoolConfig.mockResolvedValue({ pick_rule: {}, recycle_rule: {} });
});

function reqJson(path, opts = {}) {
  // ⚠ 展开顺序：opts 若携带 headers 键，`{ headers, ...opts }` 会被 opts.headers 整体覆盖
  //   （Authorization 丢失 → 401）——此处先拆出 headers 再合并，Bearer 头永远保留。
  const { headers: extraHeaders, ...rest } = opts;
  const headers = { Authorization: `Bearer ${token}`, ...(extraHeaders || {}) };
  return app.fetch(path, { ...rest, headers });
}
async function getJsonBody(path) {
  const res = await reqJson(path);
  return { status: res.status, body: await res.json() };
}

describe('T5 · GET /api/pool-config 四键契约', () => {
  it('GET 返回 { orgId, tenantId, config, legacy, seeded }，config 为 readPoolConfig 结果', async () => {
    const { status, body } = await getJsonBody('/api/pool-config');
    expect(status).toBe(200);
    expect(body.config).toEqual(TPL);
    expect(body).toHaveProperty('orgId');
    expect(body).toHaveProperty('tenantId');
    expect(body).toHaveProperty('legacy');
    expect(body.seeded).toBe(false); // TPL 无 _seeded → 未克隆
    expect(H.readPoolConfig).toHaveBeenCalledTimes(1);
    expect(H.readPoolConfig.mock.calls[0][0]).toHaveProperty('tenantId'); // 租户解析已透传
    expect(H.getPoolConfig).toHaveBeenCalledTimes(1); // legacy 兼容读
  });

  it('config 带 _seeded → seeded=true（克隆自平台模板标记被透出）', async () => {
    H.readPoolConfig.mockResolvedValue({ ...TPL, _seeded: 'system-template' });
    const { status, body } = await getJsonBody('/api/pool-config');
    expect(status).toBe(200);
    expect(body.seeded).toBe(true);
  });
});

describe('T5 · PUT /api/pool-config pools[] 合并写回', () => {
  it('pools 分支：校验通过 → writePoolConfig 收到合并后的 pools（含未改池保留）', async () => {
    const res = await reqJson('/api/pool-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pools: [{ id: 'pool-new', pick_rule: { daily_limit: 5 }, recycle_rule: { recycle_days: 45 } }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(true);

    expect(H.writePoolConfig).toHaveBeenCalledTimes(1);
    const [opts] = H.writePoolConfig.mock.calls[0];
    expect(opts).toHaveProperty('tenantId');           // scopeOf 写租户透传
    const newPools = opts.patch.pools;
    expect(newPools).toHaveLength(2);                   // 两池都保留
    const pNew = newPools.find((p) => p.id === 'pool-new');
    expect(pNew.pick_rule.daily_limit).toBe(5);        // 校验+归一后写入
    expect(pNew.recycle_rule.recycle_days).toBe(45);
    // 未改池原样保留（合并非替换）
    const pNur = newPools.find((p) => p.id === 'pool-nurture');
    expect(pNur.pick_rule.daily_limit).toBe(5);
    expect(pNur.recycle_rule.recycle_days).toBe(90);
  });

  it('pools 分支：未知字段（引擎不认的键）→ 400 拒绝，不触发写', async () => {
    const res = await reqJson('/api/pool-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pools: [{ id: 'pool-new', pick_rule: { pickRule: 'oldest' } }] }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(String(body.error)).toMatch(/不可编辑字段|pickRule/);
    expect(H.writePoolConfig).not.toHaveBeenCalled();
  });

  it('pools 分支：越界 daily_limit → 400 拒绝，不触发写', async () => {
    const res = await reqJson('/api/pool-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pools: [{ id: 'pool-new', pick_rule: { daily_limit: 0 } }] }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(String(body.error)).toMatch(/daily_limit/);
    expect(H.writePoolConfig).not.toHaveBeenCalled();
  });
});

describe('T5 · PUT /api/pool-config 旧 patch 形态（向后兼容）', () => {
  it('patch 分支：setPoolConfig 被调用（旧组织粒子写，兼容既有调用方）', async () => {
    const res = await reqJson('/api/pool-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { pick_rule: { daily_limit: 9 } } }),
    });
    expect(res.status).toBe(200);
    expect(H.setPoolConfig).toHaveBeenCalledTimes(1);
    const [orgId, patch, opts] = H.setPoolConfig.mock.calls[0];
    expect(orgId).toBe('org-hq');
    expect(patch.pick_rule.daily_limit).toBe(9);
    expect(opts).toHaveProperty('tenantId');
  });
});
