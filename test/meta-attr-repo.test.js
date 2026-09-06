// test/meta-attr-repo.test.js — metaAttrRepo DB 读写 + seed 物化 + 写时自适应钩子（DB 集成）
// 环境限制：需 PG@5433（沙箱无 PG 时标注环境限制，非回归；代码先落，待本机 PG 启动后验证）
import { describe, it, expect, beforeAll } from 'vitest';
import { query, queryWrite } from '../src/db.js';
import {
  seedMetaAttr, listMetaAttr, getMetaAttr, setMetaAttr,
  ensureAdaptiveRegistration,
} from '../src/metaAttr/metaAttrRepo.js';
import { createParticle, updateParticle } from '../src/particles/particleRepo.js';
import { PARTICLE_TYPES } from '../src/particles/particleModel.js';

beforeAll(async () => {
  await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`)
    .catch(() => {});
  await seedMetaAttr('system');   // 幂等物化全部 coreAttributes
});

describe('seedMetaAttr 幂等物化', () => {
  it('CRM_ACCOUNT.coreAttributes 全部物化且 enabled=true/source=manual', async () => {
    const rows = await listMetaAttr({ particleType: 'CRM_ACCOUNT' });
    const slugs = rows.map((r) => r.attr_slug);
    expect(slugs).toContain('name');
    expect(slugs).toContain('domains');
    expect(slugs).toContain('champion_strength');
    expect(rows.every((r) => r.enabled === true)).toBe(true);
    expect(rows.every((r) => r.source === 'manual')).toBe(true);
  });

  it('幂等：重复 seed 不产生重复行', async () => {
    const before = (await listMetaAttr({ particleType: 'CRM_DEAL' })).length;
    await seedMetaAttr('system');
    const after = (await listMetaAttr({ particleType: 'CRM_DEAL' })).length;
    expect(after).toBe(before);
  });
});

describe('写时自适应钩子（particleRepo 接线）', () => {
  it('createParticle 写入未登记新键 → meta_attr 自动登记（enabled=false, source=ai, type=number）', async () => {
    await createParticle('CRM_DEAL', { name: '自适应商机', custom_score: 88 });
    const rec = await getMetaAttr('CRM_DEAL', 'custom_score');
    expect(rec).not.toBeNull();
    expect(rec.attr_type).toBe('number');
    expect(rec.enabled).toBe(false);
    expect(rec.source).toBe('ai');
  });

  it('类型未命中（嵌套数组兜底）→ 拒绝登记且写不失败', async () => {
    await expect(
      createParticle('CRM_DEAL', { name: '脏键商机', messy: [1, [2]] })
    ).resolves.toBeDefined();
    const rec = await getMetaAttr('CRM_DEAL', 'messy');
    expect(rec).toBeNull();
  });

  it('updateParticle patch 新键 → 自动登记', async () => {
    const p = await createParticle('CRM_DEAL', { name: '更新商机' });
    await updateParticle(p.id, { patch: { extra_signal: 'high' } });
    const rec = await getMetaAttr('CRM_DEAL', 'extra_signal');
    expect(rec).not.toBeNull();
    expect(rec.attr_type).toBe('text');
    expect(rec.source).toBe('ai');
  });

  it('ensureAdaptiveRegistration 直接调用：保留键（ai/events）不登记', async () => {
    const reg = await ensureAdaptiveRegistration('CRM_DEAL', { ai: { x: 1 }, events: [1], plain_key: 'v' }, 'system');
    expect(reg).toEqual(['plain_key']);
  });
});

describe('setMetaAttr 配置变更', () => {
  it('启用后 enabled=true、version 递增', async () => {
    await setMetaAttr('CRM_DEAL', 'custom_score', { enabled: true }, { actor: 'system' });
    const rec = await getMetaAttr('CRM_DEAL', 'custom_score');
    expect(rec.enabled).toBe(true);
    expect(rec.version).toBe(2);
  });

  it('不存在的属性 → 抛错', async () => {
    await expect(setMetaAttr('CRM_DEAL', 'nope', { enabled: true }, { actor: 'system' })).rejects.toThrow();
  });
});

describe('种子完整性：全粒子 identity 兜底', () => {
  beforeAll(async () => {
    await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`).catch(() => {});
    await seedMetaAttr('system');
  });

  it('CRM_DEAL 仅 identity name → 1 行且 enabled/required/source 正确', async () => {
    const r = await getMetaAttr('CRM_DEAL', 'name');
    expect(r).not.toBeNull();
    expect(r.enabled).toBe(true);
    expect(r.required).toBe(true);
    expect(r.source).toBe('manual');
    const all = await listMetaAttr({ particleType: 'CRM_DEAL', enabled: true });
    expect(all.length).toBe(1);
  });

  it('CRM_APPROVAL_FLOW 身份兜底生效（含 APPROVAL 配置粒子）', async () => {
    const r = await getMetaAttr('CRM_APPROVAL_FLOW', 'name');
    expect(r).not.toBeNull();
    expect(r.enabled).toBe(true);
  });

  it('CRM_ACCOUNT name 同现 coreAttributes+identity → 仅 1 行（去重）', async () => {
    const all = await listMetaAttr({ particleType: 'CRM_ACCOUNT' });
    const names = all.filter((x) => x.attr_slug === 'name');
    expect(names.length).toBe(1);
  });

  it('全量 enabled 行数 = Σ(各粒子 coreAttributes∪identity 去重)', async () => {
    const expected = Object.entries(PARTICLE_TYPES).reduce((acc, [, def]) => {
      const set = new Set([...Object.keys(def.coreAttributes || {}), ...(def.identity || [])]);
      return acc + set.size;
    }, 0);
    const all = await listMetaAttr({ enabled: true });
    expect(all.length).toBe(expected);
  });
});

describe('identity 字段类型约束启用（防 adaptive 抢占 + 版本号归一）', () => {
  beforeAll(async () => {
    await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`).catch(() => {});
    await seedMetaAttr('system');
  });

  it('CRM_APPROVAL_VERSION.version_no 登记为 number 且启用（不被 identity 兜底退化成 text）', async () => {
    const r = await getMetaAttr('CRM_APPROVAL_VERSION', 'version_no');
    expect(r).not.toBeNull();
    expect(r.attr_type).toBe('number');
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('manual');
  });

  it('类型归一生效：写入字符串 "1" → 归一为数字 1（消除 identity 指纹漂移）', async () => {
    const p = await createParticle(
      'CRM_APPROVAL_VERSION',
      { flow_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', version_no: '1', nodes: [] },
      { tenantId: 'system' }
    );
    expect(p.payload?.version_no).toBe(1);
  });

  it('【回归】adaptive 抢占 identity 字段后，re-seed 纠正为 manual + enabled', async () => {
    const PT = 'CRM_APPROVAL_VERSION';
    const SLUG = 'version_no';
    // 制造抢占态：模拟写粒子触发自适应登记（source='ai', enabled=false）抢先占位
    await queryWrite(`DELETE FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2`, [PT, SLUG]);
    await queryWrite(
      `INSERT INTO crm.meta_attr (particle_type, attr_slug, title, attr_type, semantic_tag, source, enabled, required, version, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [PT, SLUG, SLUG, 'number', 'identity', 'ai', false, false, 1, 'system']
    );
    await seedMetaAttr('system');
    const r = await getMetaAttr(PT, SLUG);
    expect(r.source).toBe('manual');   // 抢占行须被纠正回人工源
    expect(r.enabled).toBe(true);      // 类型约束须重新启用
  });
});