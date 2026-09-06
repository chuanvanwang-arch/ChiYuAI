// test/web/ontologyConfig.test.js — 第 22 项 粒子模型/本体/词汇配置（S27）TDD 测试
// 注入式 handler（router.handlers）+ 假 deps，不依赖真实库；范式对齐 userManagement.test.js（21 例）
// 红线校验：词汇禁删（停用=软标记）、写经决策第0闸、非 sysadmin 写 403、模型快照只读 9 真粒子
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateVocabularyPatch,
  renderVocabulary,
  renderModelSnapshot,
  createOntologyRouter,
  PARTICLE_MODEL,
} from '../../src/portal/ontologyConfig.js';

// —— 纯函数：validateVocabularyPatch ——
describe('validateVocabularyPatch', () => {
  it('合法：term+type+layer+state 全部通过', () => {
    const r = validateVocabularyPatch({ term: 'AI agent', type: '业务术语', layer: 'L1', state: 'ACTIVE' });
    expect(r.ok).toBe(true);
    expect(r.normalized.term).toBe('AI agent');
  });
  it('term 缺失/空 → 拒绝', () => {
    expect(validateVocabularyPatch({}).ok).toBe(false);
    expect(validateVocabularyPatch({ term: '' }).ok).toBe(false);
  });
  it('term 超 120 字 → 拒绝', () => {
    expect(validateVocabularyPatch({ term: 'x'.repeat(121) }).ok).toBe(false);
  });
  it('state 非 ACTIVE/INACTIVE → 拒绝', () => {
    expect(validateVocabularyPatch({ term: 'x', state: 'DELETED' }).ok).toBe(false);
  });
  it('未知字段 → 拒绝', () => {
    const r = validateVocabularyPatch({ term: 'x', embedding_ref: '手工改向量' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/不可编辑|未知/);
  });
});

// —— 纯函数：renderVocabulary ——
describe('renderVocabulary', () => {
  it('ACTIVE 在前、INACTIVE 带停用标记', () => {
    const html = renderVocabulary([
      { id: '1', term: '医药', type: '业务术语', layer: 'L1', state: 'ACTIVE', enabled: true },
      { id: '2', term: '停用词', type: '业务术语', layer: 'L1', state: 'INACTIVE', enabled: false },
    ]);
    expect(html).toContain('医药');
    expect(html.indexOf('医药')).toBeLessThan(html.indexOf('停用词'));
    expect(html).toContain('停用');
  });
  it('空 → 降级', () => {
    expect(renderVocabulary([])).toContain('无词汇');
  });
});

// —— 纯函数：renderModelSnapshot ——
describe('renderModelSnapshot', () => {
  it('24 全量粒子 + 6 语义标签 + 19 类型（模型快照全量，真粒子主集 9）', () => {
    const html = renderModelSnapshot(PARTICLE_MODEL);
    for (const t of Object.keys(PARTICLE_MODEL.particleTypes)) expect(html).toContain(t);
    expect(html).toContain('firmographic');
    expect(html).toContain('record-reference'); // 19 种属性类型之一（渲染值列表而非常量名）
    expect(html).toContain('真粒子'); // 9 真主集标注
  });
});

// —— handler（fake deps，不触真实库）——
function makeDeps(rows = []) {
  const vocab = rows.map((r) => ({ ...r }));
  const query = vi.fn(async (sql, params = []) => {
    if (String(sql).startsWith('SELECT')) {
      return { rows: vocab.map(({ ...r }) => r) };
    }
    if (String(sql).startsWith('INSERT')) {
      const row = {
        id: 'v-' + (vocab.length + 1),
        term: params[0],
        type: params[1] || '业务术语',
        layer: params[2] || 'L1',
        state: 'ACTIVE',
        enabled: true,
        created_at: new Date(),
      };
      vocab.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (String(sql).startsWith('UPDATE')) {
      const id = params[0];
      const u = vocab.find((r) => r.id === id);
      if (u && sql.includes('state')) u.state = params[1];
      return { rows: [u || {}], rowCount: u ? 1 : 0 };
    }
    return { rows: [] };
  });
  const recordDecisionEvent = vi.fn(async () => ({ event_id: 'ev-x' }));
  const resolveMe = vi.fn(async () => ({ ok: true, role: 'admin', tenantId: 'system', display_name: 'Admin', username: 'admin' }));
  const modelSnapshot = vi.fn(async () => PARTICLE_MODEL);
  // 注入内存版词汇读写（内部触发 query spy 保留 SQL 断言；handler 不触真实库）
  const listVocabulary = vi.fn(async (tenantId) => vocab.map(({ ...r }) => r));
  const upsertVocabulary = vi.fn(async (arg1, arg2, arg3, arg4) => {
    // 有 id（编辑/停用）→ 更新内存行；无 id（新增）→ 按 term upsert
    if (typeof arg1 === 'string' && vocab.some((r) => r.id === arg1)) {
      const u = vocab.find((r) => r.id === arg1);
      const p = arg2 || {};
      if (p.state) u.state = p.state;
      if (p.term) u.term = p.term;
      if (p.type) u.type = p.type;
      if (p.layer) u.layer = p.layer;
      query(`UPDATE crm.particles SET state=$2 WHERE id=$1`, [arg1, p.state]);
      return { id: arg1 };
    }
    // 新增：按 term 查重（幂等）
    const term = typeof arg1 === 'string' ? arg1 : arg1?.term;
    const existing = vocab.find((r) => r.term === term);
    if (existing) {
      const p = typeof arg1 === 'object' ? arg1 : { term, type: arg2, layer: arg3, state: arg4 };
      if (p.type) existing.type = p.type;
      if (p.layer) existing.layer = p.layer;
      if (p.state) existing.state = p.state;
      return { id: existing.id };
    }
    const row = { id: 'v-' + (vocab.length + 1), term, type: arg2 || '业务术语', layer: arg3 || 'L1', state: arg4 || 'ACTIVE', enabled: true, created_at: new Date() };
    vocab.push(row);
    query(`INSERT INTO crm.particles (type, slug, title, state, payload) VALUES('CRM_KNOWLEDGE', $2, $1, $3, $4)`, [term, slugify(term), row.state, {}]);
    return { id: row.id };
  });
  return { query, recordDecisionEvent, resolveMe, modelSnapshot, listVocabulary, upsertVocabulary, _rows: vocab };
}

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'vocab';
}

describe('createOntologyRouter handlers', () => {
  let d, router;
  beforeEach(() => {
    d = makeDeps([
      { id: 'v-1', term: '医药', type: '业务术语', layer: 'L1', state: 'ACTIVE', enabled: true, created_at: new Date() },
    ]);
    router = createOntologyRouter(d);
  });

  it('GET /api/config/ontology/vocabulary → 词汇数组', async () => {
    let body;
    await router.handlers.getVocabulary({}, { json: (o) => (body = o) });
    expect(body.vocabulary.length).toBe(1);
    expect(body.vocabulary[0].term).toBe('医药');
  });

  it('PUT /api/config/ontology/vocabulary 新增 → 落库 + 决策第0闸', async () => {
    let body;
    const req = { body: { patch: { term: 'AI agent', type: '业务术语', layer: 'L1' } } };
    await router.handlers.putVocabulary(req, { json: (o) => (body = o) });
    expect(body.ok).toBe(true);
    expect(d.recordDecisionEvent).toHaveBeenCalledWith('config_change', expect.objectContaining({ type: 'vocabulary_upsert' }));
    const inserted = d._rows.find((r) => r.term === 'AI agent');
    expect(inserted).toBeTruthy();
  });

  it('PUT 停用 → state=INACTIVE 软标记（无 DELETE 路径）', async () => {
    let body;
    const req = { body: { id: 'v-1', patch: { state: 'INACTIVE' } } };
    await router.handlers.putVocabulary(req, { json: (o) => (body = o) });
    expect(body.ok).toBe(true);
    expect(d._rows.find((r) => r.id === 'v-1').state).toBe('INACTIVE');
  });

  it('PUT 非法 term → 400', async () => {
    let status;
    await router.handlers.putVocabulary(
      { body: { patch: { term: '' } } },
      { json: () => {}, status: (s) => ((status = s), { json: () => {} }) }
    );
    expect(status).toBe(400);
  });

  it('非 sysadmin 写 → 403', async () => {
    d.resolveMe.mockResolvedValueOnce({ ok: true, role: 'sales', tenantId: 't-a' });
    let status, statusBody;
    await router.handlers.putVocabulary(
      { body: { patch: { term: 'x' } } },
      { json: () => {}, status: (s) => ((status = s), { json: (o) => ((statusBody = o), null) }) }
    );
    expect(status).toBe(403);
    expect(statusBody.error).toMatch(/权限/);
  });

  // —— 2026-09-05：#22 移租户级 —— 闸放宽为 tan_admin(本租户)/sysadmin/ADMIN + 词汇按 tenant_id 隔离 ——
  it('ten_admin(本租户) GET → 过闸且 listVocabulary 收到本租户 tenantId', async () => {
    d.resolveMe.mockResolvedValueOnce({ ok: true, role: 'ten_admin', tenantId: 't-a' });
    let body;
    await router.handlers.getVocabulary({}, { json: (o) => (body = o) });
    expect(body.vocabulary.length).toBe(1);
    expect(d.listVocabulary).toHaveBeenCalledWith('t-a');
  });

  it('ten_admin(本租户) PUT 新增 → 过闸 + 决策第0闸 + 写入限定本租户', async () => {
    d.resolveMe.mockResolvedValueOnce({ ok: true, role: 'ten_admin', tenantId: 't-a' });
    let body;
    const req = { body: { patch: { term: '印刷包装', type: '业务术语', layer: 'L1' } } };
    await router.handlers.putVocabulary(req, { json: (o) => (body = o) });
    expect(body.ok).toBe(true);
    expect(d.recordDecisionEvent).toHaveBeenCalled();
    expect(d.upsertVocabulary).toHaveBeenCalledWith('印刷包装', '业务术语', 'L1', undefined, 't-a');
  });

  it('ten_admin PUT 编辑(id,patch) → tenantId 作第三参透传（跨租户改写被数据层 tenant_id 闸挡）', async () => {
    d.resolveMe.mockResolvedValueOnce({ ok: true, role: 'ten_admin', tenantId: 't-a' });
    let body;
    const req = { body: { id: 'v-1', patch: { state: 'INACTIVE' } } };
    await router.handlers.putVocabulary(req, { json: (o) => (body = o) });
    expect(body.ok).toBe(true);
    expect(d.upsertVocabulary).toHaveBeenCalledWith('v-1', { state: 'INACTIVE' }, 't-a');
  });

  it('sysadmin(t-a) GET → 过闸（sysadmin 跨租户管理）', async () => {
    d.resolveMe.mockResolvedValueOnce({ ok: true, role: 'sysadmin', tenantId: 't-a' });
    let body;
    await router.handlers.getVocabulary({}, { json: (o) => (body = o) });
    expect(body.vocabulary).toBeDefined();
  });

  it('admin(system) GET → listVocabulary 收到 system（通配全量）', async () => {
    let body;
    await router.handlers.getVocabulary({}, { json: (o) => (body = o) });
    expect(d.listVocabulary).toHaveBeenCalledWith('system');
  });

  it('GET /api/config/ontology/model → 29 全量粒子快照（含 9 真主集 + 业务主数据/审批六层/方法论证据等衍生粒子）', async () => {
    let body;
    await router.handlers.getModel({}, { json: (o) => (body = o) });
    expect(Object.keys(body.model.particleTypes).length).toBe(29);
    expect(body.model.attributeTypeSet.length).toBe(19);
    expect(body.model.coreParticleIds).toHaveLength(9);
  });
});