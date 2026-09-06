// test/import-service.test.js — T3-10 导入 upsert + 批量写 Action（H27：导入新建/更新双模式，幂等）
// 验收：① upsert 按 ID 匹配（存在更新/不存在新增，重复导入不重复）② 批量写过闸（confirm 必需）③ 导出带唯一 ID
import { describe, it, expect, beforeEach } from 'vitest';
import { partitionRows, validateRows, toExportRows } from '../src/sales/importService.js';

// —— upsert 分派/校验 纯逻辑（无 PG）——
describe('T3-10 · upsert 分派 + 行校验纯逻辑', () => {
  it('insert 模式：全部走新建通道', () => {
    const r = partitionRows([{ name: 'A' }, { name: 'B' }], 'insert');
    expect(r.toCreate).toHaveLength(2);
    expect(r.toUpdate).toHaveLength(0);
  });

  it('upsert 模式：有 id → 更新；无 id → 新建（幂等分流）', () => {
    const r = partitionRows([{ id: 'p1', name: 'A' }, { name: 'B' }, { id: 'p2', name: 'C' }], 'upsert');
    expect(r.toUpdate.map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(r.toCreate).toHaveLength(1);
    expect(r.toCreate[0].name).toBe('B');
  });

  it('行级必填校验：缺字段 → 拒该行（不中断整批）', () => {
    const ok = validateRows([{ name: 'A' }, { name: 'B' }], ['name']);
    expect(ok.ok).toBe(true);
    expect(ok.errors).toHaveLength(0);
    const bad = validateRows([{ name: 'A' }, { other: 1 }], ['name']);
    expect(bad.ok).toBe(false);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0].row).toBe(2);
  });

  it('导出带唯一 ID（匹配键闭环）', () => {
    const rows = toExportRows([{ id: 'p1', payload: { name: 'A', amount: 100 } }]);
    expect(rows[0]).toEqual({ id: 'p1', name: 'A', amount: 100 });
  });
});

// —— 批量写 Action 接线（H27：批量写过闸 confirm 必需）——
import { seedActions } from '../src/action/seed-actions.js';
import { resetRegistry, getAction, detectCrudExplosion } from '../src/action/registry.js';

describe('T3-10 · crm-import-batch Action 接线', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
  });

  it('crm-import-batch 已注册（confirm critical → 批量写必须确认）', () => {
    const a = getAction('crm-import-batch');
    expect(a).not.toBeNull();
    expect(a.confirm).toBe('critical');
    expect(a.autoDecision).toBe(true);
    expect(a.namespace).toBe('crm');
    expect(a.schema.particle_type).toBe('string');
    expect(a.schema.mode).toBe('string');
  });

  it('反爆炸护栏：crm-import-batch 属单意图批量域 Action（非 CRUD 爆炸）', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).not.toContain('crm-import-batch');
  });
});