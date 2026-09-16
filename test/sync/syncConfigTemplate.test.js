// test/sync/syncConfigTemplate.test.js — P0-3：同步配置模板静态守卫
// 价值：播种 SQL 一旦写错 particle_type（不存在于 PARTICLE_TYPES），真库会造出孤儿类型粒子
//       ——本测试在无 DB 前提下锁死「模板 ↔ 粒子模型」一致性（呼应 tier-predicate-parity 守卫范式）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PARTICLE_TYPES } from '../../src/particles/particleModel.js';
import { normalizeSyncMappings } from '../../src/sync/mount.js';
import { createMappingResolver } from '../../src/sync/mapping.js';

const sqlRaw = readFileSync(new URL('../../db/migration-sync-config.sql', import.meta.url), 'utf8');
// ⚠ 断言前必须剥离 SQL 行注释：本文件头注含「WHERE NOT EXISTS」「禁删」等词，
//   未剥离会造成计数假红/禁词假红（同族教训：解释性注释含禁词 → 代码越规范测试越红）。
const sql = sqlRaw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

function jsonForKey(key) {
  const m = sql.match(new RegExp(`SELECT 'system', '${key}', '([\\s\\S]*?)'::jsonb`));
  if (!m) throw new Error(`SQL 未找到键 ${key}`);
  return JSON.parse(m[1]);
}

describe('同步配置模板（P0-3）', () => {
  it('三键齐备且幂等（WHERE NOT EXISTS）+ 禁删', () => {
    for (const k of ['sync-mappings', 'sync-trust', 'integration-providers']) {
      expect(sql.includes(`'${k}'`), `${k} 应被播种`).toBe(true);
    }
    expect(sql.match(/WHERE NOT EXISTS/g)?.length).toBe(3);
    expect(sql.includes('DELETE')).toBe(false); // 禁删铁律
  });

  it('sync-mappings 覆盖 6 类对象且 particle_type 全为既有类型（防孤儿类型）', () => {
    const raw = jsonForKey('sync-mappings');
    const norm = normalizeSyncMappings(raw);
    expect(Object.keys(norm).sort()).toEqual(['account', 'contract', 'lead', 'opportunity', 'product', 'quotation']);
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

  it('同步配置模板可被 mapping 层消费（至少一类对象能成功 apply，而非全 skipped）', () => {
    const norm = normalizeSyncMappings(jsonForKey('sync-mappings'));
    const m = createMappingResolver({ mappings: norm });
    const r = m.apply('account', { id: 'E1', name: '客户A', industry: '制造', 未知字段: 'x' });
    expect(r.ok).toBe(true);
    expect(r.particle_type).toBe('CRM_ACCOUNT');
    expect(r.payload.name).toBe('客户A');
    expect(r.external_id).toBe('E1'); // identity.external_id_field='id' 生效
    expect(r.skippedFields).toContain('未知字段');
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
    expect(inbound.length).toBe(6);
    for (const n of inbound) expect(mappingKeys, `descriptor object ${n} 无对应映射（会全 skipped）`).toContain(n);
  });
});
