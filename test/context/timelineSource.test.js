// T8(BG-01b 叙事时间线进注入层 / BG-08 时间基准统一)——纯函数与四源检索测试
import { describe, it, expect } from 'vitest';
import {
  DECISION_TIME_BASIS,
  buildTimelineRows,
  chronological,
  retrieveTimeline,
  formatTimelineRow,
} from '../../src/context/timelineSource.js';
import { buildTimelineRows as reExported } from '../../src/account/insightService.js';
import { assembleContext } from '../../src/context/assembler.js';

const stubLayers = {
  L1: async () => [], L2: async () => ({ decisions: [], memories: [] }),
  L3: async () => ({ tasks: [], agents: [] }), L4: async () => ({}),
};

const mkRow = (ts, type, entityId, over = {}) => ({
  ts, type, title: `${type}-title`, source: type, actor: 'alice',
  entityType: 'X', entityId, summary: '', ...over,
});

describe('T8/BG-08 — 决策时间基准单一事实源', () => {
  it('DECISION_TIME_BASIS 固定为 COALESCE(decided_at, created_at)', () => {
    expect(DECISION_TIME_BASIS).toBe('COALESCE(decided_at, created_at)');
  });

  it('决策源 SQL 的排序与取值均引用同一时间基准常量（杜绝 decided_at/created_at 漂移）', async () => {
    const captured = [];
    const fakeQuery = async (sql) => {
      captured.push(sql);
      return { rows: [] };
    };
    await retrieveTimeline({ accountId: 'a1', dealIds: [], query: fakeQuery });
    const decisionSql = captured.find((s) => s.includes('FROM crm.decision'));
    expect(decisionSql).toBeTruthy();
    expect(decisionSql).toContain(DECISION_TIME_BASIS);
    expect(decisionSql).not.toMatch(/ORDER BY created_at DESC/);
    expect(decisionSql).not.toMatch(/ORDER BY decided_at DESC/);
  });
});

describe('T8 — 决策源必须同时匹配 accountId 与 dealIds（2026-09-03 回归锁）', () => {
  // 缺陷：销售决策的 involved_entities 常只挂 CRM_DEAL、不挂 CRM_ACCOUNT。
  //   决策源此前仅按 accountId 匹配 → 客户洞察页「决策总数」恒 0、决策链恒空。
  // 锁：SQL 必须出现 dealIds 数组占位（$4::text[]），且参数第 4 位必须是 dealIds 数组。
  it('决策源 SQL 含 dealIds 数组匹配分支（ANY($4::text[])）', async () => {
    const captured = [];
    const fakeQuery = async (sql) => { captured.push(sql); return { rows: [] }; };
    await retrieveTimeline({ accountId: 'a1', dealIds: ['d1', 'd2'], query: fakeQuery });
    const decisionSql = captured.find((s) => s.includes('FROM crm.decision'));
    expect(decisionSql).toBeTruthy();
    expect(decisionSql).toContain('ANY($4::text[])');
  });

  it('决策源实际收到 dealIds 作为第 4 个参数', async () => {
    const seen = [];
    const fakeQuery = async (sql, params) => {
      if (sql.includes('FROM crm.decision')) seen.push(params);
      return { rows: [] };
    };
    await retrieveTimeline({ accountId: 'a1', dealIds: ['d1', 'd2'], query: fakeQuery });
    expect(seen).toHaveLength(1);
    expect(seen[0][3]).toEqual(['d1', 'd2']);
  });
});

describe('T8 — 标题兜底链取真实字段（2026-09-03 回归锁）', () => {
  // 缺陷：fallbackTitle 的 event_type / topic 分支存在，但 SQL 未 SELECT 这两个列
  //   → 回退链一路掉到底，整列显示无信息量的「事件」「记忆」。
  it('event 源 SELECT 了 type AS event_type（行级类型列）', async () => {
    const captured = [];
    const fakeQuery = async (sql) => { captured.push(sql); return { rows: [] }; };
    await retrieveTimeline({ accountId: 'a1', dealIds: [], query: fakeQuery });
    const evSql = captured.find((s) => s.includes('FROM crm.events'));
    expect(evSql).toContain('type AS event_type');
  });

  it('memory 源 SELECT 了 topic（唯一可读标识）', async () => {
    const captured = [];
    const fakeQuery = async (sql) => { captured.push(sql); return { rows: [] }; };
    await retrieveTimeline({ accountId: 'a1', dealIds: [], query: fakeQuery });
    const mlSql = captured.find((s) => s.includes('FROM crm.memory_log'));
    expect(mlSql).toContain('topic');
  });

  it('event 无 title 时合成「类型 · 实体类型」，而非退化为「事件」', async () => {
    const fakeQuery = async (sql) => {
      if (sql.includes('FROM crm.events')) {
        return { rows: [{ type: 'event', occurred_at: '2026-01-01', entity_id: 'e1',
                          event_type: 'ontology-sync', entity_type: 'CRM_ACCOUNT' }] };
      }
      return { rows: [] };
    };
    const rows = await retrieveTimeline({ accountId: 'a1', dealIds: [], query: fakeQuery });
    expect(rows[0].title).toBe('ontology-sync · CRM_ACCOUNT');
  });

  it('event 的 source 列做 COALESCE 兜底（生产 payload 无 source 键，实测 125 行命中 0）', async () => {
    const captured = [];
    const fakeQuery = async (sql) => { captured.push(sql); return { rows: [] }; };
    await retrieveTimeline({ accountId: 'a1', dealIds: [], query: fakeQuery });
    const evSql = captured.find((s) => s.includes('FROM crm.events'));
    expect(evSql).toMatch(/COALESCE\(NULLIF\(payload->>'source',''\), *'事件总线'\)/);
  });

  it('memory 无 title 时回退到 topic，而非「记忆」', async () => {
    const fakeQuery = async (sql) => {
      if (sql.includes('FROM crm.memory_log')) {
        return { rows: [{ type: 'memory', occurred_at: '2026-01-01', entity_id: 'm1',
                          topic: 'deal:intelligence:2026-09-03' }] };
      }
      return { rows: [] };
    };
    const rows = await retrieveTimeline({ accountId: 'a1', dealIds: [], query: fakeQuery });
    expect(rows[0].title).toBe('deal:intelligence:2026-09-03');
  });

  // 回归锁：生产 crm.events.actor / crm.decision.decider_role 均存在 NULL 行
  // （上海印通客户时间线曾 5 行执行者列全空 → 页面出现空单元格）。执行者必须兜底，不留空。
  it('actor 为 NULL 时兜底为「系统」，不产生空执行者单元格', async () => {
    const fakeQuery = async (sql) => {
      if (sql.includes('FROM crm.events')) {
        return { rows: [{ type: 'event', occurred_at: '2026-01-03', entity_id: 'e1',
                          actor: null, source: '事件总线' }] };
      }
      if (sql.includes('FROM crm.decision')) {
        return { rows: [{ type: 'decision', occurred_at: '2026-01-02', entity_id: 'd1',
                          scenario_id: 'QUOTE_PRICING', actor: null }] };
      }
      return { rows: [] };
    };
    const rows = await retrieveTimeline({ accountId: 'a1', dealIds: [], query: fakeQuery });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.actor).toBeTruthy();
      expect(r.actor).toBe('系统');
    }
  });

  it('actor 非空时原样保留，不被兜底覆盖', async () => {
    const fakeQuery = async (sql) => {
      if (sql.includes('FROM crm.events')) {
        return { rows: [{ type: 'event', occurred_at: '2026-01-03', entity_id: 'e1',
                          actor: 'alice', source: 'CRM' }] };
      }
      return { rows: [] };
    };
    const rows = await retrieveTimeline({ accountId: 'a1', dealIds: [], query: fakeQuery });
    expect(rows[0].actor).toBe('alice');
  });
});

describe('T8 — buildTimelineRows 纯函数（与原 insightService 行为一致）', () => {
  it('按 ts 倒序排列', () => {
    const rows = buildTimelineRows([
      mkRow('2026-01-01T00:00:00Z', 'event', 'e1'),
      mkRow('2026-03-01T00:00:00Z', 'decision', 'd1'),
      mkRow('2026-02-01T00:00:00Z', 'task', 't1'),
    ]);
    expect(rows.map((r) => r.type)).toEqual(['decision', 'task', 'event']);
  });

  it('同一秒 + 同一类型 + 同一实体去重', () => {
    const rows = buildTimelineRows([
      mkRow('2026-01-01T00:00:00Z', 'event', 'e1'),
      mkRow('2026-01-01T00:00:00Z', 'event', 'e1'),
      mkRow('2026-01-01T00:00:00Z', 'event', 'e2'),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('空输入不抛错', () => {
    expect(buildTimelineRows([])).toEqual([]);
    expect(buildTimelineRows(undefined)).toEqual([]);
  });

  it('insightService re-export 与 context 实现同源（单一事实源，未分叉）', () => {
    expect(reExported).toBe(buildTimelineRows);
  });
});

describe('T8 — chronological（注入用正序）', () => {
  it('把倒序行翻转为最早→最近', () => {
    const desc = [mkRow('2026-03-01', 'a', '1'), mkRow('2026-01-01', 'b', '2')];
    expect(chronological(desc).map((r) => r.type)).toEqual(['b', 'a']);
  });
  it('不修改原数组', () => {
    const desc = [mkRow('2026-03-01', 'a', '1'), mkRow('2026-01-01', 'b', '2')];
    chronological(desc);
    expect(desc[0].type).toBe('a');
  });
});

describe('T8 — retrieveTimeline 四源只读聚合', () => {
  it('无实体作用域返回 [] 且不发起任何查询（叙事是可选增强，非必需层）', async () => {
    let calls = 0;
    const fakeQuery = async () => { calls += 1; return { rows: [] }; };
    const rows = await retrieveTimeline({ accountId: null, dealIds: [], query: fakeQuery });
    expect(rows).toEqual([]);
    expect(calls).toBe(0);
  });

  it('四源并集返回，决策源时间取 occurred_at（COALESCE 产物）', async () => {
    const fakeQuery = async (sql) => {
      if (sql.includes('FROM crm.events')) return { rows: [{ type: 'event', title: '拜访', actor: 'bob', occurred_at: new Date('2026-01-02'), entity_type: 'EVENT', entity_id: 'e1' }] };
      if (sql.includes('FROM crm.tasks')) return { rows: [{ type: 'task', title: '跟进', actor: 'system', occurred_at: new Date('2026-01-03'), entity_type: 'TASK', entity_id: 't1' }] };
      if (sql.includes('FROM crm.decision')) return { rows: [{ type: 'decision', title: 'stage-gate', actor: 'sales', occurred_at: new Date('2026-01-04'), entity_type: 'DECISION', entity_id: 'd1' }] };
      if (sql.includes('FROM crm.memory_log')) return { rows: [{ type: 'memory', title: '纪要', actor: 'system', occurred_at: new Date('2026-01-01'), entity_type: 'NOTE', entity_id: 'm1' }] };
      return { rows: [] };
    };
    const rows = await retrieveTimeline({ accountId: 'a1', query: fakeQuery });
    expect(rows).toHaveLength(4);
    // A3（2026-09-02 契约变更）：retrieveTimeline 返回即**跨源全局倒序**。
    //   旧契约是四源分组拼接（不排序）→ 跨源时序错乱；assembler.js 记得补 buildTimelineRows，
    //   insightService.js 直接用返回值 → 洞察页故事线乱序。现排序内聚，调用方拿到即有序。
    //   本断言锁定新契约：decision(01-04) > task(01-03) > event(01-02) > memory(01-01)。
    expect(rows.map((r) => r.type)).toEqual(['decision', 'task', 'event', 'memory']);
    expect(rows[0].ts).toContain('2026-01-04'); // 最新在前
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].ts >= rows[i].ts).toBe(true); // 全局有序，不只是分组有序
    }
    // buildTimelineRows 对已排序输入幂等（assembler.js 的二次调用无副作用）
    const sorted = buildTimelineRows(rows);
    expect(sorted.map((r) => r.type)).toEqual(['decision', 'task', 'event', 'memory']);
  });

  it('单源查询失败不抛错（降级：该源静默缺失，其余源继续）', async () => {
    const fakeQuery = async (sql) => {
      if (sql.includes('FROM crm.memory_log')) throw new Error('memory down');
      if (sql.includes('FROM crm.events')) return { rows: [{ type: 'event', occurred_at: '2026-01-02', entity_id: 'e1' }] };
      return { rows: [] };
    };
    const rows = await retrieveTimeline({ accountId: 'a1', query: fakeQuery });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('event');
  });

  it('四源 title 为空时按类型回退，避免时间线标题列空白', async () => {
    const fakeQuery = async (sql) => {
      if (sql.includes('FROM crm.events')) return { rows: [{ type: 'event', payload: { action: '拜访客户' }, actor: 'bob', occurred_at: new Date('2026-01-02'), entity_type: 'EVENT', entity_id: 'e1' }] };
      if (sql.includes('FROM crm.tasks')) return { rows: [{ type: 'task', action_name: 'lead-follow-up', actor: 'system', occurred_at: new Date('2026-01-03'), entity_type: 'TASK', entity_id: 't1' }] };
      if (sql.includes('FROM crm.decision')) return { rows: [{ type: 'decision', scenario_id: 'STAGE_PROGRESSION', actor: 'sales', occurred_at: new Date('2026-01-04'), entity_type: 'DECISION', entity_id: 'd1' }] };
      if (sql.includes('FROM crm.memory_log')) return { rows: [{ type: 'memory', topic: 'decision:d1', kind: 'decision', payload: {}, actor: 'system', occurred_at: new Date('2026-01-01'), entity_type: 'NOTE', entity_id: 'm1' }] };
      return { rows: [] };
    };
    const rows = await retrieveTimeline({ accountId: 'a1', query: fakeQuery });
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(byType.event.title).toBe('拜访客户');
    expect(byType.task.title).toBe('lead-follow-up');
    expect(byType.decision.title).toBe('STAGE_PROGRESSION');
    expect(byType.memory.title).toBe('decision:d1');
  });
});

describe('T8 — assembleContext 装配叙事时间线（WHEN 轴）', () => {
  it('intent 带 accountId 时填充 narrative.rows 且 available=true', async () => {
    const b = await assembleContext(
      { actor: 'alice', intent: { accountId: 'a1', dealIds: ['d1'] }, query: '' },
      { ...stubLayers, narrative: async () => buildTimelineRows([mkRow('2026-01-02', 'event', 'e1')]) }
    );
    expect(b.narrative.available).toBe(true);
    expect(b.narrative.rows).toHaveLength(1);
    expect(b.narrative.unavailable_reason).toBeNull();
  });

  it('叙事检索抛错 → 留痕 unavailable_reason=error，但不标记 degraded（可选增强层）', async () => {
    const b = await assembleContext(
      { actor: 'alice', intent: { accountId: 'a1' }, query: '' },
      { ...stubLayers, narrative: async () => { throw new Error('timeline down'); } }
    );
    expect(b.degraded).toBe(false);
    expect(b.narrative.available).toBe(false);
    expect(b.narrative.unavailable_reason).toBe('error');
    expect(b.narrative.error).toContain('timeline down');
  });

  it('narrative:false 显式关闭时不装配（供纯 L1–L4 场景）', async () => {
    const b = await assembleContext(
      { actor: 'alice', intent: { accountId: 'a1' }, query: '' },
      { ...stubLayers, narrative: false }
    );
    expect(b.narrative.available).toBe(false);
    expect(b.narrative.unavailable_reason).toBe('no-scope');
  });

  it('L1 抛错仍不影响叙事装配（WHEN 轴独立于降级链）', async () => {
    const b = await assembleContext(
      { actor: 'alice', intent: { accountId: 'a1' }, query: '' },
      { ...stubLayers, L1: async () => { throw new Error('vector down'); },
        narrative: async () => buildTimelineRows([mkRow('2026-01-02', 'event', 'e1')]) }
    );
    expect(b.degraded).toBe(true);
    expect(b.narrative.available).toBe(true);
  });
});

describe('T8 — formatTimelineRow（WHEN 轴单行渲染）', () => {
  it('输出「时间 来源｜执行者｜事件」可追溯格式', () => {
    const s = formatTimelineRow({ ts: '2026-01-02T10:30:00Z', source: '决策', actor: 'sales', title: '阶段推进' });
    expect(s).toContain('2026-01-02 10:30');
    expect(s).toContain('决策｜sales｜阶段推进');
  });
  it('缺字段退化为占位符而非 undefined', () => {
    const s = formatTimelineRow({});
    expect(s).not.toContain('undefined');
  });
});
