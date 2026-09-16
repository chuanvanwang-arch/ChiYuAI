import { describe, it, expect } from 'vitest';
import { createCursorStore } from 'file:///D:/system/CRM-ai-native/src/sync/cursor.js';

describe('sync cursor（运行留痕）', () => {
  it('set 用 upsert 更新不新建行（同租户×provider×object 一行）', async () => {
    const rows = [];
    const store = createCursorStore({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO crm.sync_cursor')) {
          // 模拟 ON CONFLICT DO UPDATE 语义：同 (tenant,provider,object) 已存在 → 更新既有行不新增
          const existing = rows.find(r => r.tenant_id === params[0] && r.provider === params[1] && r.external_object === params[2]);
          // SQL 参数序：tenant,provider,object,cursor,status,error,last_counts,decision_id → last_counts=params[6]
          const row = { tenant_id: params[0], provider: params[1], external_object: params[2], cursor_value: params[3], last_status: params[4], last_counts: params[6] };
          if (existing) {
            Object.assign(existing, { cursor_value: row.cursor_value, last_status: row.last_status, last_counts: row.last_counts });
            return { rows: [existing] };
          }
          rows.push(row);
          return { rows: [row] };
        }
        if (sql.includes('SELECT * FROM crm.sync_cursor')) {
          return { rows: rows.filter(r => r.tenant_id === params[0] && r.provider === params[1] && r.external_object === params[2]) };
        }
        return { rows: [] };
      },
    });
    await store.set({ tenantId: 't1', provider: 'mock', object: 'AccountObj', counts: { read: 2, created: 1 }, status: 'ok' });
    await store.set({ tenantId: 't1', provider: 'mock', object: 'AccountObj', counts: { read: 3, created: 0 }, status: 'ok' });
    expect(rows.length).toBe(1); // 不新建行
    expect(rows[0].last_counts).toBe(JSON.stringify({ read: 3, created: 0 }));
  });
});
