// test/web/billing-plan-form.smoke.test.js — 套餐表单化冒烟（DB-free）
// 守护点：
//   F1 弹窗为结构化表单（含全部关键字段输入项），不再有 plan-edit-json 整档 JSON 文本框
//   F2 权益勾选区容器存在（勾选项由后端 known_entitlements 动态下发，前端不硬编码清单）
//   F3 GET /api/billing/plans 下发 known_entitlements=planSchema 白名单（单一事实源）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KNOWN_ENTITLEMENTS } from '../../src/billing/planSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const page = () => readFileSync(path.join(ROOT, 'src/web/admin-billing-console.html'), 'utf8');
const routes = () => readFileSync(path.join(ROOT, 'src/http/billingRoutes.js'), 'utf8');

describe('套餐编辑表单化', () => {
  it('F1 表单含全部关键字段，且 JSON 文本框已移除', () => {
    const html = page();
    for (const id of ['pf-plan-id', 'pf-name', 'pf-quote', 'pf-features', 'pf-seat-price', 'pf-base-fee',
      'pf-seats', 'pf-tokens', 'pf-hard-cap', 'pf-overage-mode', 'pf-overage-price', 'pf-ents', 'pf-enabled', 'pf-err']) {
      expect(html, `缺少表单字段 #${id}`).toContain(`id="${id}"`);
    }
    expect(html, '不应再保留整档 JSON 编辑框 plan-edit-json').not.toContain('plan-edit-json');
  });
  it('F2 权益勾选由 JS 按 ENT_LIST 动态渲染', () => {
    const html = page();
    expect(html).toContain('renderEntCheckboxes');
    expect(html).toContain("d.known_entitlements");
  });
  it('F3 plans GET 响应携带 known_entitlements（来自 planSchema 单一事实源）', () => {
    expect(routes()).toContain('known_entitlements: KNOWN_ENTITLEMENTS');
    expect(KNOWN_ENTITLEMENTS.length).toBeGreaterThanOrEqual(10);
  });
  it('F4 计费设置初始值必须走 crm-textarea 的 .value（组件属性驱动，不读子文本内容）', () => {
    const html = page();
    // renderSettings 用 innerHTML 插入后以 .value 赋初始值（2026-09-05 修复空框）
    expect(html).toMatch(/querySelector\('#settings-json'\)[\s\S]{0,60}\.value\s*=/);
    // 禁止回弹：以子文本内容形式给 crm-textarea 塞初始 JSON（组件不读 textContent，框会全空）
    expect(html).not.toMatch(/<crm-textarea[^>]*settings-json[^>]*>[^<]+<\/crm-textarea>/);
  });
});
