#!/usr/bin/env node
// scripts/smoke-decision-scenarios.mjs — 一键 e2e 自检决策场景配置页（用户复盘命令）
// 跑通此脚本可证明：API 数据 + ESM 模块 + 路由 + 渲染 全链路 OK，
//                  否则按建议做对应修复。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOST = process.env.HOST || 'http://localhost:3000';

async function login() {
  const r = await fetch(`${HOST}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('登录失败: ' + JSON.stringify(j));
  return j.token;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

(async () => {
  console.log(`▶ e2e 自检 ${HOST}/decision-scenarios.html`);
  console.log('--- 1. API + Token ---');
  const token = await login();
  assert(token.length > 50, 'admin 登录拿到 Bearer token');

  console.log('--- 2. /api/decision-scenarios ---');
  const apiR = await fetch(`${HOST}/api/decision-scenarios`, { headers: { authorization: `Bearer ${token}` } });
  assert(apiR.ok, `API 返回 ${apiR.status}`);
  const api = await apiR.json();
  const scenarios = api.scenarios || [];
  assert(scenarios.length > 0, `API 返回 ${scenarios.length} 条场景`);
  const SALES = ['一、线索', '二、机会评估', '三、客户策略', '四、方案价值', '五、商务报价', '六、签单前风险', '七、终局决策', '八、丢单复盘'];
  const salesScenarios = scenarios.filter((s) => SALES.includes(s.stage));
  assert(salesScenarios.length === 8, `销售场景 8 条（实际 ${salesScenarios.length}）`);

  console.log('--- 3. ESM 模块 sendFile ---');
  const modR = await fetch(`${HOST}/portal/decisionScenarioRender.js`);
  assert(modR.ok, `决策场景渲染模块 返回 ${modR.status}`);
  const modSrc = await modR.text();
  assert(modSrc.length > 1000, `模块体长度 ${modSrc.length} 字节（>1000=有效）`);
  assert(modSrc.includes('export const SALES_STAGE_ORDER'), '模块导出 SALES_STAGE_ORDER');

  console.log('--- 4. HTML sendFile ---');
  const htmlR = await fetch(`${HOST}/decision-scenarios.html`);
  assert(htmlR.ok, `决策场景 HTML 返回 ${htmlR.status}`);
  const htmlSrc = await htmlR.text();
  assert(htmlSrc.includes('id="ds-sub-count"'), 'HTML 模板含副标题计数锚点');
  assert(htmlSrc.includes('import * as ds from'), 'HTML 模板 import 决策场景渲染模块');

  console.log('--- 5. 模拟 frontend render ---');
  const tmp = path.join(ROOT, '.tmp-ds-render.mjs');
  fs.writeFileSync(tmp, modSrc);
  const mod = await import('file://' + tmp);
  fs.unlinkSync(tmp);
  const presentStages = mod.SALES_STAGE_ORDER.filter((st) => scenarios.some((s) => s.stage === st));
  assert(presentStages.length === 8, `presentStages ${presentStages.length} 个销售 stage`);
  const activeStage = presentStages[0] || null;
  assert(activeStage, 'activeStage 已确认');
  const stageHtml = mod.renderStageCards(scenarios, activeStage, { diffOnly: false });
  const cards = (stageHtml.match(/<article class="ds-card/g) || []).length;
  assert(cards >= 1, `active stage 渲染 ≥1 张卡片（实际 ${cards}）`);
  const noSalesEmpty = stageHtml.includes('无销售场景');
  assert(!noSalesEmpty, `renderStageCards 未返回「无销售场景」`);

  console.log('\n=== 全部自检通过 ===');
  console.log('如果浏览器仍显示「无销售场景」，请按 Ctrl+Shift+R 强刷一次清 ESM 缓存。');
})().catch((e) => {
  console.error('\n✗ 自检失败:', e.message);
  process.exit(2);
});
