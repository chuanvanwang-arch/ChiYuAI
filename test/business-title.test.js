// test/business-title.test.js — 工商抬头写时校验（F18：信用代码 GB 32100-2015 校验 + 四要素必填）
// 纯逻辑本地可跑（无 PG 依赖）；接线：hooks.js 写时钩子 + conn-zhizao-verify-account 写入前调用
import { describe, it, expect } from 'vitest';
import { isValidCreditCode, validateBusinessTitle, normalizeBusinessTitle, BUSINESS_TITLE_FIELDS } from '../src/sales/businessTitle.js';

// 已知合法示例（GB 32100-2015 加权模31校验位正确；前缀 17 位 91330106MA27XJ3X7 → 校验位 Q）
const VALID_CODE = '91330106MA27XJ3X7Q'; // 测试用合法码（18 位字符集合法 + 校验位正确）
const VALID_BT = { title: '浙江测试科技有限公司', credit_code: VALID_CODE, reg_address: '杭州市西湖区', legal_person: '王川' };

describe('统一社会信用代码校验 isValidCreditCode（GB 32100-2015）', () => {
  it('合法 18 位码通过', () => {
    expect(isValidCreditCode(VALID_CODE)).toBe(true);
  });
  it('非 18 位拒绝', () => {
    expect(isValidCreditCode('91330106MA27XJ3X7')).toBe(false);
    expect(isValidCreditCode('91330106MA27XJ3X7TT')).toBe(false);
  });
  it('含非法字符拒绝（I/O/Z/S/V 不在字符集）', () => {
    expect(isValidCreditCode('91I30106MA27XJ3X7Q')).toBe(false); // I 不在字符集
    expect(isValidCreditCode('9133106MA27XJ3X7Q')).toBe(false);  // 长度错误（17 位）
  });
  it('空/非字符串拒绝', () => {
    expect(isValidCreditCode('')).toBe(false);
    expect(isValidCreditCode(null)).toBe(false);
    expect(isValidCreditCode(undefined)).toBe(false);
  });
});

describe('工商四要素校验 validateBusinessTitle', () => {
  it('完整合法抬头通过', () => {
    expect(validateBusinessTitle(VALID_BT).ok).toBe(true);
  });
  it('四要素缺失→拒绝并载明字段', () => {
    const r = validateBusinessTitle({ title: '只有名字' });
    expect(r.ok).toBe(false);
    for (const f of ['credit_code', 'reg_address', 'legal_person']) {
      expect(r.errors.join()).toContain(f);
    }
  });
  it('非法信用代码→拒绝', () => {
    const r = validateBusinessTitle({ ...VALID_BT, credit_code: '123456' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('非法统一社会信用代码');
  });
  it('null/undefined→拒绝；字符串抬头（人工/种子手动填写的 text 类型）→放行', () => {
    expect(validateBusinessTitle(null).ok).toBe(false);
    expect(validateBusinessTitle(undefined).ok).toBe(false);
    // 字符串 = particleModel 声明的 text 类型（人工/种子抬头名称），无信用代码可污染本体，F18 放行
    expect(validateBusinessTitle('上海印通包装科技有限公司（一般纳税人）').ok).toBe(true);
    expect(validateBusinessTitle('x').ok).toBe(true);
  });
  it('四要素清单字段名正确', () => {
    expect(BUSINESS_TITLE_FIELDS).toEqual(['title', 'credit_code', 'reg_address', 'legal_person']);
  });
});

describe('normalizeBusinessTitle（规范化，幂等）', () => {
  it('补空字段 + 去首尾空白', () => {
    expect(normalizeBusinessTitle({ title: ' 抬头 ', credit_code: VALID_CODE })).toEqual({
      title: '抬头', credit_code: VALID_CODE, reg_address: '', legal_person: '',
    });
  });
});