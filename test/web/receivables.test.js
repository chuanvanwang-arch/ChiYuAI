// test/web/receivables.test.js — S05 T2 应收看板页结构契约（TDD：先失败后实现）
// 验证：receivables.html 含四区挂载点（overview/contract-table/invoice-block/overdue-block）
//       + 受控页硬依赖样式链（tokens.css/common.css）+ finance 守卫逻辑
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const htmlPath = new URL('../../src/web/receivables.html', import.meta.url);
const html = readFileSync(htmlPath, 'utf8');

describe('receivables.html 结构契约（S05 T2）', () => {
  it('含四区挂载点 + 受控样式链', () => {
    expect(html).toContain('id="overview"');        // 总览卡
    expect(html).toContain('id="contract-table"');  // 合同应收明细
    expect(html).toContain('id="invoice-block"');   // 发票对账
    expect(html).toContain('id="overdue-block"');   // 逾期区
    expect(html).toContain('/portal/tokens.css');
    expect(html).toContain('/portal/common.css');
  });

  it('finance 守卫只判 role（对齐 config.html 铁律：me() 无 ok 字段）', () => {
    expect(html).toMatch(/r\?\.role\s*!==\s*'finance'/);
    expect(html).toContain('forbidden');            // 非 finance 拦截块
  });
});