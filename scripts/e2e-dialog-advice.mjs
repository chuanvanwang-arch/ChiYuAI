/**
 * E2E：对话驱动决策建议（docs/plans/2026-09-08-dialog-driven-decision-advice.md）
 *
 * 真实端到端验证（非单元测试）：起真实 HTTP 服务 + 真实 MCP stdio 通道，
 * 验证 5 条链路是否真的产出建议卡。
 *
 * 依赖：HTTP 服务在线（PORT，默认 3100，避免占用开发用 3000）。
 * 用法：PORT=3100 PGDATABASE=crm_native_test node scripts/e2e-dialog-advice.mjs
 */
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PORT = Number(process.env.PORT || 3100);
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(b) });
          } catch {
            resolve({ status: res.statusCode, raw: b.slice(0, 300) });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── A. 平台内 NL 入口：POST /api/page/from-nl 应附加 advice ───
console.log('\n── A. 平台内 NL 入口 (/api/page/from-nl) ──');
{
  const r = await postJson('/api/page/from-nl', { nl: '客户要求 8 折，还要再降 10%' });
  const advice = r.json && r.json.advice;
  check('A1 HTTP 201', r.status === 201, `status=${r.status}`);
  check('A2 响应含 advice', !!advice, advice ? `tier=${advice.tier} 场景=${advice.scenario_id} 阶段=${advice.stage}` : JSON.stringify(r.json).slice(0, 150));
  if (advice) {
    check('A3 坐标定位到 QUOTE_PRICING', advice.scenario_id === 'QUOTE_PRICING', `实际=${advice.scenario_id}`);
    // 折扣类诉求属红线场景（db/seed.sql 中 default_tier=HIGH），必须进 B 档以上，不得给自治处置
    check('A4 折扣类诉求未给 A 档自治处置', advice.tier !== 'A', `tier=${advice.tier} disposition=${advice.disposition}`);
  }
}

// ─── B. MCP 通道 ───
console.log('\n── B. MCP 通道 (stdio) ──');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js', '--stdio'],
  env: { ...process.env, PGDATABASE: process.env.PGDATABASE || 'crm_native_test' },
  stderr: 'pipe',
});
const client = new Client({ name: 'e2e-dialog-advice', version: '1.0.0' });

// MCP 工具 permission='auth'：必须先 crm_login 换 token，否则全部返回 gate=auth_required。
// 教训（2026-09-08 E2E 实测）：不登录时响应体仍是合法 JSON，若只判 `!!advice` 会误判为通过。
async function login() {
  const r = await client.callTool({
    name: 'crm_login',
    arguments: { username: process.env.E2E_USER || 'alice', password: process.env.E2E_PASS || 'secret123' },
  });
  const p = r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r;
  if (!p.ok || !p.token) throw new Error(`登录失败: ${JSON.stringify(p).slice(0, 200)}`);
  return p.token;
}
// 统一解包：非法 JSON 或网关拒绝（gate=xxx）都会让 ok!==true，必须显式暴露而非静默通过
function unpack(r) {
  if (!r.content?.[0]?.text) return r;
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return { ok: false, raw: r.content[0].text.slice(0, 200) };
  }
}

try {
  await client.connect(transport);
  check('B1 MCP 连接建立', true);

  const token = await login();
  check('B2 crm_login 拿到 token', !!token, `actor=${process.env.E2E_USER || 'alice'}`);
  const auth = { api_token: token };

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check('B3 tool crm-decision-advise 已暴露', names.includes('crm-decision-advise'), `共 ${names.length} 个工具`);

  // B4. 主动建议工具：折扣诉求
  const r1 = await client.callTool({ name: 'crm-decision-advise', arguments: { ...auth, utterance: '客户要求 8 折，还要再降 10%', stage: 'S4' } });
  const payload1 = unpack(r1);
  const a1 = payload1.advice;
  check('B4 折扣诉求返回建议卡', payload1.ok === true && !!a1, a1 ? `tier=${a1.tier} 场景=${a1.scenario_id} 阶段=${a1.stage}` : JSON.stringify(payload1).slice(0, 200));
  if (a1) {
    check('B5 坐标=QUOTE_PRICING@S4', a1.scenario_id === 'QUOTE_PRICING' && a1.stage === 'S4', `${a1.scenario_id}@${a1.stage}`);
    check('B6 折扣类不给 A 档自治', a1.tier !== 'A', `tier=${a1.tier}`);
  }

  // B6b. 顺序复现：同工具连续调用是否稳定（E2E 首次跑发现「第一次成功、后续 not found」）
  const rRep = await client.callTool({ name: 'crm-decision-advise', arguments: { ...auth, utterance: '客户要求 8 折', stage: 'S4' } });
  const pRep = unpack(rRep);
  check('B6b 同工具连续调用稳定', pRep.ok === true, JSON.stringify(pRep).slice(0, 200));

  // B7. 样品诉求（应落 SOLUTION_VALUE@S3）
  // B7. 样品诉求（应落 SOLUTION_VALUE@S3）
  // 注：实测约 1/18 偶发 'Tool not found'（MCP 动作表懒加载竞态，非本功能确定性缺陷），重试 3 次以区分偶发与真失败
  let payload2 = null, tries2 = 0;
  for (let k = 0; k < 3; k++) {
    tries2 = k + 1;
    const rr = await client.callTool({ name: 'crm-decision-advise', arguments: { ...auth, utterance: '客户要 600g 样品先小试', stage: 'S3' } });
    payload2 = unpack(rr);
    if (payload2 && payload2.ok === true) break;
  }
  const a2 = payload2 && payload2.advice;
  check('B7 样品诉求定位 SOLUTION_VALUE@S3', !!a2 && a2.scenario_id === 'SOLUTION_VALUE' && a2.stage === 'S3', (a2 ? a2.scenario_id + '@' + a2.stage + ' tier=' + a2.tier : 'no advice') + ' (tries=' + tries2 + ')');

  // B7b. 逐段拆分 utterance，定位触发 'Tool not found' 的词
  const CASES = [['ascii','sample test'],['600g','600g'],['yaopin','样品'],['want-yaopin','客户要样品'],['full','客户要 600g 样品先小试']];
  for (const cs of CASES) {
    const rr = await client.callTool({ name: 'crm-decision-advise', arguments: { ...auth, utterance: cs[1], stage: 'S3' } });
    const pp = unpack(rr);
    const adv = pp.advice || (pp.data && pp.data.advice);
    console.log('   [utt] ' + cs[0] + ' -> ' + (pp.ok === true ? 'OK scenario=' + (adv && adv.scenario_id) : 'FAIL ' + JSON.stringify(pp).slice(0, 80)));
  }

  // B8. 无意义输入：不得抛错，降级为 C 档
  const r3 = await client.callTool({ name: 'crm-decision-advise', arguments: { ...auth, utterance: '今天天气不错' } });
  const payload3 = unpack(r3);
  const a3 = payload3.advice;
  check('B8 无命中输入降级 C 档且不抛错', payload3.ok === true && a3 && a3.tier === 'C', a3 ? `tier=${a3.tier} 场景=${a3.scenario_id}` : JSON.stringify(payload3).slice(0, 200));

  // B8b. 稳定性探针：连续多次调用同一工具，统计 not found 竞态与响应结构一致性
  let okN = 0, failN = 0;
  const shapes = new Set();
  for (let k = 0; k < 8; k++) {
    const rr = await client.callTool({ name: 'crm-decision-advise', arguments: { ...auth, utterance: 'sample test', stage: 'S3' } });
    const pp = unpack(rr);
    if (pp.ok === true) okN++; else failN++;
    shapes.add(Object.keys(pp).sort().join('|'));
  }
  check('B8b 连续 8 次调用稳定', failN === 0, `ok=${okN} fail=${failN} shapes=${[...shapes].join(' , ')}`);

  // B9. MCP 写工具 phase1 应附加 advice（第 0 闸前置建议）
  const writeTool = ['crm-deal-advance', 'crm_deal_advance', 'crm-quote-create'].find((n) => names.includes(n));
  if (!writeTool) {
    check('B9 MCP 写 phase1 附加 advice', false, '未找到可用写工具（tools/list 无 crm-deal-advance）');
  } else {
    const rw = await client.callTool({
      name: writeTool,
      arguments: { ...auth, deal_id: 'e2e-probe', to_stage: 'S4', utterance: '客户要求 8 折', confirm: false },
    });
    const pw = unpack(rw);
    check('B9 MCP 写 phase1 附加 advice', !!pw.advice, pw.advice ? `tier=${pw.advice.tier} 场景=${pw.advice.scenario_id}` : `工具=${writeTool} 响应=${JSON.stringify(pw).slice(0, 160)}`);
  }
} catch (e) {
  check('B MCP 通道', false, e.message);
} finally {
  await client.close().catch(() => {});
}

// ─── 汇总 ───
const failed = results.filter((r) => !r.pass);
console.log(`\n════ E2E 结果：${results.length - failed.length}/${results.length} 通过 ════`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
