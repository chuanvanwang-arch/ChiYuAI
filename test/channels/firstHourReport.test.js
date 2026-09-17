// test/channels/firstHourReport.test.js — T10：第一小时价值物（Rox 价值前置本土化）
// 判据：① 汇入统计 → 报告（含条数/命中账户/窗口）；② **零导入不伪装成功**（has_data=false + 明示文案）；
//       ③ 纯函数（无副作用）；④ 各渠道分项可辨（by_channel）。
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
    expect(r.has_data).toBe(true);
    expect(r.summary).toContain('12');
    expect(r.summary).toContain('16'); // 总条数 12+3+1（wechat 0 不计）
    expect(r.accounts).toEqual(['acme.com', 'bob.com']);
    expect(r.total).toBe(16);
    // 零值渠道不出现在分项文案里（避免「wechat:0」这种噪声）
    expect(r.summary).not.toContain('wechat');
  });

  it('零导入 → 报告仍生成，但 has_data=false（明示「未接入或无数据」，不伪装成功）', () => {
    const r = buildFirstHourReport({ tenantId: 't1', imported: {}, accountsHit: [], window_days: 30 });
    expect(r.has_data).toBe(false);
    expect(r.total).toBe(0);
    expect(r.summary).toContain('未接入');
    expect(r.summary).not.toContain('已自动汇入');
    expect(r.headline).toContain('尚未');
  });

  it('全零渠道（{email:0}）同样视为无数据（不得因存在键而谎报有数据）', () => {
    const r = buildFirstHourReport({ imported: { email: 0, calendar: 0 } });
    expect(r.has_data).toBe(false);
    expect(r.total).toBe(0);
  });

  it('by_channel 分项可辨（呈现层单源）', () => {
    const r = buildFirstHourReport({ imported: { email: 2, wechat: 5 } });
    expect(r.by_channel).toEqual({ email: 2, wechat: 5 });
  });

  it('纯函数：无参调用不抛（缺省安全）', () => {
    expect(() => buildFirstHourReport()).not.toThrow();
    expect(buildFirstHourReport().has_data).toBe(false);
  });
});
