/**
 * E2E：报价红线真实透出（P0 合并交付验证）
 *
 * 真实端到端：起 MCP stdio 通道 + 真实 MCP 登录 + 真实 crm-decision-advise 调用，
 * 验证「折扣超权限红线 + 毛利红线」是否真的在建议卡里带回 redlines 与 approval_prefill
 * （只提示+预填，绝不自动写——符合设计 §10 HITL）。
 *
 * 设计铁律（2026-09-08 复盘）：单测全绿 ≠ 链路通，交付前必须跑真实 E2E。
 * 依赖：PGDATABASE=crm_native_test（不显式设会连生产！）
 * 用法：PGDATABASE=crm_native_test node scripts/e2e-quote-redline-mcp.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { queryWrite } from '../src/db.js';
import { writeConfig } from '../src/config/configStore.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ─── 0. 父进程内准备测试库固件（与 MCP 子进程共享同一 crm_native_test）───
const TENANT = 'system'; // alice 属 system 租户，政策读 system 模板
const dealSlug = 'e2e-redline-' + Date.now();
const polSlug = 'e2e-offerpol-' + Date.now();
const PRICE_AUTH = {
  default_max_discount_pct: 10,
  roles: { sales: { max_discount_pct: 10 }, presales: { max_discount_pct: 15 }, manager: { max_discount_pct: 30 }, director: { max_discount_pct: 100 } },
};
const REQ_DIMS = { levels: ['MUST', 'SHOULD', 'NICE'], dimensions: [
  { dim_key: 'REQ_PRICE_BASELINE', label: '报价基线确认', level: 'MUST' },
  { dim_key: 'REQ_DISCOUNT_AUTHORITY', label: '折扣权限确认', level: 'MUST' },
  { dim_key: 'REQ_WRITTEN_APPROVAL', label: '书面批文', level: 'MUST' },
  { dim_key: 'REQ_BUDGET', label: '预算落实', level: 'SHOULD' },
  { dim_key: 'REQ_TIMELINE', label: '交付时间表', level: 'SHOULD' },
  { dim_key: 'REQ_TRIAL', label: '试用安排', level: 'NICE' },
] };

let dealId = null, polId = null;
async function setup() {
  await writeConfig('price-authority', PRICE_AUTH, { tenantId: TENANT });
  await writeConfig('requirement-dimensions', REQ_DIMS, { tenantId: TENANT });
  const d = await queryWrite(
    `INSERT INTO crm.particles (type, tenant_id, state, slug, title, payload)
     VALUES ('CRM_DEAL',$1,'active',$2,$3,$4::jsonb) RETURNING id`,
    [TENANT, dealSlug, 'E2E redline deal', JSON.stringify({ amount: 100000, cost: 90000, discount_pct: 20 })]
  );
  dealId = d.rows[0].id;
  // 租户报价政策：成本 9 万、毛利红线 20% → 报价 10 万毛利 10% 破线
  const p = await queryWrite(
    `INSERT INTO crm.particles (type, tenant_id, state, slug, title, payload)
     VALUES ('CRM_OFFER_POLICY',$1,'active',$2,$3,$4::jsonb) RETURNING id`,
    [TENANT, polSlug, 'E2E offer policy', JSON.stringify({
      subtype: 'standard', cost_structure: '[{"cost":90000}]', price_bands: '{"floor":85000}', margin_redline: 0.2,
    })]
  );
  polId = p.rows[0].id;
  console.log(`固件就绪：deal=${dealId} policy=${polId} tenant=${TENANT}`);
}
async function teardown() {
  if (dealId) await queryWrite('DELETE FROM crm.particles WHERE id=$1', [dealId]).catch(() => {});
  if (polId) await queryWrite('DELETE FROM crm.particles WHERE id=$1', [polId]).catch(() => {});
}

// ─── 1. MCP stdio 通道 ───
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js', '--stdio'],
  env: { ...process.env, PGDATABASE: process.env.PGDATABASE || 'crm_native_test' },
  stderr: 'pipe',
});
const client = new Client({ name: 'e2e-quote-redline', version: '1.0.0' });

function unpack(r) {
  if (!r.content?.[0]?.text) return r;
  try { return JSON.parse(r.content[0].text); } catch { return { ok: false, raw: r.content[0].text.slice(0, 200) }; }
}
async function login() {
  const r = await client.callTool({ name: 'crm_login', arguments: { username: process.env.E2E_USER || 'alice', password: process.env.E2E_PASS || 'secret123' } });
  const p = unpack(r);
  if (!p.ok || !p.token) throw new Error('登录失败: ' + JSON.stringify(p).slice(0, 200));
  return p.token;
}

await setup();
try {
  await client.connect(transport);
  check('M1 MCP 连接建立', true);
  const token = await login();
  check('M2 crm_login 拿到 token', !!token, `actor=${process.env.E2E_USER || 'alice'}`);
  const auth = { api_token: token };

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check('M3 tool crm-decision-advise 已暴露', names.includes('crm-decision-advise'), `共 ${names.length} 个工具`);

  // 折扣类诉求 + 持 deal（折扣 20% 超 sales 上限 10% → 折扣红线；毛利 10% < 20% → 毛利红线）
  let payload = null, tries = 0;
  for (let k = 0; k < 3; k++) {
    tries = k + 1;
    const rr = await client.callTool({ name: 'crm-decision-advise', arguments: { ...auth, utterance: '客户要求 8 折', deal_id: dealId, stage: 'S4' } });
    payload = unpack(rr);
    if (payload && payload.ok === true) break;
  }
  const advice = payload && payload.advice;
  check('M4 报价红线建议卡返回', payload && payload.ok === true && !!advice, advice ? `tier=${advice.tier} 场景=${advice.scenario_id}` : JSON.stringify(payload).slice(0, 200) + ` (tries=${tries})`);
  if (payload) console.log('   [debug] degraded=', JSON.stringify(payload.degraded), 'redlines=', JSON.stringify((advice && advice.redlines) || []), 'reasons=', JSON.stringify((advice && advice.reasons) || []).slice(0, 200));
  if (!advice) throw new Error('无建议卡，终止');

  check('M5 坐标=QUOTE_PRICING@S4', advice.scenario_id === 'QUOTE_PRICING' && advice.stage === 'S4', `${advice.scenario_id}@${advice.stage}`);
  check('M6 红线命中 → B 档（不自治处置）', advice.tier === 'B', `tier=${advice.tier}`);

  const conds = (advice.redlines || []).map((r) => r.cond);
  check('M7 含折扣超权限红线', conds.includes('discount_authority_exceeded'), 'redlines=' + JSON.stringify(conds));
  const dRed = (advice.redlines || []).find((r) => r.cond === 'discount_authority_exceeded');
  if (dRed) check('M7b 折扣红线带 gap_pct/role/requested', dRed.gap_pct != null && dRed.role != null && dRed.requested != null, JSON.stringify(dRed).slice(0, 160));

  // 毛利红线：若租户政策被正确读取应出现（非致命，作附加校验）
  const hasMargin = conds.includes('margin_redline');
  check('M8 含毛利红线（租户政策已读取）', hasMargin, hasMargin ? 'margin_redline 已透出' : '未出现（政策未被读取，需排查 resolveOfferPolicy）');

  // 最关键：红线只预填审批参数，绝不自动写
  check('M9 红线触发 approval_prefill', !!advice.approval_prefill, advice.approval_prefill ? `action=${advice.approval_prefill.action}` : '缺失');
  if (advice.approval_prefill) {
    check('M10 预填 action=crm-approval-start（不自动发起）', advice.approval_prefill.action === 'crm-approval-start', `flow=${advice.approval_prefill.flow_id}`);
    check('M11 预填 note 声明不自动写', /不自动发起/.test(advice.approval_prefill.note || ''), (advice.approval_prefill.note || '').slice(0, 40));
    check('M12 预填 business_id = deal', advice.approval_prefill.business_id === dealId, `biz=${advice.approval_prefill.business_id} deal=${dealId}`);
  }

  // 负向对照：无红线的普通诉求不应进 B 档/不预填审批
  const r2 = await client.callTool({ name: 'crm-decision-advise', arguments: { ...auth, utterance: '今天天气不错', stage: 'S4' } });
  const p2 = unpack(r2);
  const a2 = p2 && p2.advice;
  check('M13 无红线诉求不预填审批/不进 B 档', a2 && a2.tier !== 'B' && !a2.approval_prefill, a2 ? `tier=${a2.tier}` : JSON.stringify(p2).slice(0, 120));
} catch (e) {
  check('M MCP 通道执行', false, e.message);
} finally {
  await client.close().catch(() => {});
  await teardown().catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n════ 报价红线 E2E：${results.length - failed.length}/${results.length} 通过 ════`);
if (failed.length) { for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`); }
process.exit(failed.length ? 1 : 0);
