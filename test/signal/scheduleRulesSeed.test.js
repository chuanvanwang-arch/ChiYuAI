// test/signal/scheduleRulesSeed.test.js — 日期规则播种模板守卫
// 为什么需要：`signal-schedule` **已存在**（13 租户 × 2 条旧规则）→ 不能用「WHERE NOT EXISTS 整键播种」
//   （键已存在则整段跳过，新规则永远到不了存量租户）。必须**按键内追加、且按 rule.id 幂等**。
//   守卫三条：① 只追加不覆盖（无 DELETE / 无整键覆盖写）；② 按 rule.id 判存在；③ 覆盖全部既有租户行。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../db/migration-signal-schedule-rules.sql', import.meta.url), 'utf8');

describe('日期规则播种模板', () => {
  it('含两类新规则 id 与前瞻/周期语义声明', () => {
    expect(sql).toContain('tender-deadline');
    expect(sql).toContain('report-due');
    expect(sql).toContain('due_within_days');
    expect(sql).toContain('periodic');
  });

  it('tender_deadline 绑 CRM_DEAL 且显式声明 ts_field（禁回退 updated_at）', () => {
    expect(sql).toMatch(/"ts_field"\s*:\s*"tender_deadline"/);
    expect(sql).toContain('CRM_DEAL');
  });

  it('零 DELETE、零整键覆盖写（禁删铁律 + 不覆盖运营配置）', () => {
    const code = sql.replace(/--[^\n]*/g, ''); // 剥离注释后再断言（防注释里的解释性用词造成假红）
    expect(code).not.toMatch(/\bDELETE\b/i);
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/ON\s+CONFLICT\s*\(\s*key\s*\)/i); // 复合 PK 下 (key) 无唯一约束 → 必报错
  });

  it('按 rule.id 幂等（存在性判定读 rules 数组元素 id）', () => {
    expect(sql).toMatch(/NOT\s+EXISTS[\s\S]*rule->>'id'/i);
  });

  it('覆盖既有租户行（判定不得限定 tenant_id，否则存量租户拿不到新规则）', () => {
    // 断言方式：两条 UPDATE 的 WHERE 只按 key 过滤；若有人误加 `AND tenant_id='system'`，
    //   则 13 个业务租户的 rules 永不加规则（静默失效）→ 本断言即该回归的锚点。
    const updates = sql.match(/UPDATE\s+crm\.config_store[\s\S]*?WHERE\s+c\.key\s*=\s*'signal-schedule'/gi) || [];
    expect(updates.length).toBe(2);
    for (const u of updates) expect(u).not.toMatch(/tenant_id\s*=/i);
  });
});
