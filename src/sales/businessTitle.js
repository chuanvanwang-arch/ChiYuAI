// src/sales/businessTitle.js — 工商抬头写时校验（F18：唯一信用代码校验 + 工商四要素必填）
// 设计输入：综合详设 §5 F18（工商抬头 + 企查查联动 → 写时校验连接器）
// 铁律：写 ACCOUNT 工商字段 → 自动校验（非法信用代码拒绝，防脏数据污染本体，ai-ontology-vector-build 写时校验实证）
// 纯判定（无 PG 依赖，可本地单测）；接线方 = hooks.js 写时钩子 + conn-zhizao-verify-account 写入前调用

// 统一社会信用代码格式：18 位（1 登记管理部门码 + 1 机构类别码 + 6 行政区划码 + 9 主体标识码 + 1 校验码）
// 字符集：0-9 + A-Z（不含 I/O/Z/S/V 等易混字符，GB 32100-2015）
export const CREDIT_CODE_RE = /^[0-9A-HJ-NPQRTUWXY]{18}$/;

// 校验统一社会信用代码（GB 32100-2015 加权模 31 校验）
export function isValidCreditCode(code) {
  if (typeof code !== 'string') return false;
  const c = code.toUpperCase();
  if (!CREDIT_CODE_RE.test(c)) return false;
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const chars = '0123456789ABCDEFGHJKLMNPQRTUWXY'; // GB 32100 字符映射（0-9 + 去 I/O/S/V/Z）
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const v = chars.indexOf(c[i]);
    if (v < 0) return false;
    sum += v * weights[i];
  }
  const check = (31 - (sum % 31)) % 31;
  return chars[check] === c[17];
}

// 工商四要素（F18 实证：统一社会信用代码 / 注册地址 / 法定代表人 / 抬头名称）
export const BUSINESS_TITLE_FIELDS = ['title', 'credit_code', 'reg_address', 'legal_person'];

// 校验工商抬头（写时校验闸）：
//  - 字符串形式 = 人工/种子手动填写的抬头名称（particleModel 声明 business_title 为 'text'，evaluator 亦按 String() 处理）；
//    无结构化信用代码可污染本体，F18 直接放行。
//  - 对象形式 = 连接器（企查查）写入的结构化工商档案：非法信用代码拒绝 + 四要素必填。
//  - null/undefined → 拒绝。
// 返回 { ok, errors }; errors 逐个载明违反项（写前校验，机器可读）
export function validateBusinessTitle(bt) {
  if (typeof bt === 'string') return { ok: true, errors: [] };
  if (!bt || typeof bt !== 'object') return { ok: false, errors: ['business_title 必须为对象或字符串'] };
  const errors = [];
  for (const f of BUSINESS_TITLE_FIELDS) {
    if (bt[f] === undefined || bt[f] === null || String(bt[f]).trim() === '') {
      errors.push(`工商四要素缺失: ${f}`);
    }
  }
  if (bt.credit_code !== undefined && bt.credit_code !== null && bt.credit_code !== '') {
    if (!isValidCreditCode(bt.credit_code)) {
      errors.push('非法统一社会信用代码: 必须为 18 位（GB 32100-2015）且校验位正确');
    }
  }
  return { ok: errors.length === 0, errors };
}

// 幂等：校验通过的标准结构（缺失值不补，仅规范化）
export function normalizeBusinessTitle(bt) {
  return {
    title: String(bt.title ?? '').trim(),
    credit_code: String(bt.credit_code ?? '').trim(),
    reg_address: String(bt.reg_address ?? '').trim(),
    legal_person: String(bt.legal_person ?? '').trim(),
  };
}