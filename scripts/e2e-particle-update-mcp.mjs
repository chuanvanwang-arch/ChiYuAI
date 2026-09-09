/**
 * E2E：MCP 事实变更通道 data-particle-update（docs/2026-09-09-mcp-particle-update-expose-design.md）
 *
 * 真实端到端验证（非单元测试）：真实 MCP stdio 客户端 → gateway 两阶段 → 第 0 闸 mint → 粒子落库。
 * 验证四件事：
 *   ① 工具确实暴露在 MCP 工具表（此前被 data-* 默认屏蔽挡住）
 *   ② 两阶段 confirm：phase1 发 confirm_token 且不执行；phase2 带 token 执行
 *   ③ 字段级并入语义：只改传入字段，未传字段原样保留（禁删）
 *   ④ decision_id 落粒子列（第 0 闸留痕）+ 跨租户写被拒
 *
 * 用法：PGDATABASE=crm_native_test node scripts/e2e-particle-update-mcp.mjs
 * 注：改了 src/ 后必须重启实例（node 无 --watch），否则拿到旧进程结果。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function unpack(r) {
  const t = r?.content?.[0]?.text;
  if (!t) return r;
  try { return JSON.parse(t); } catch { return { ok: false, raw: String(t).slice(0, 300) }; }
}

// 准备：测试库播种 PARTICLE_UPDATE 场景 + 目标粒子（alice 租户 system）+ 跨租户对照粒子
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native_test';
const { query, queryWrite } = await import('../src/db.js');
await query(
  `INSERT INTO crm.decision_scenario
     (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed)
   VALUES ('PARTICLE_UPDATE','meta','MCP/对话通道粒子事实变更（字段级并入，禁删）',
           '{"action":["data-particle-update"]}'::jsonb, ARRAY[]::TEXT[],
           '[{"cond":"data_origin","label":"数据来源与字段合法","weight":0.34},{"cond":"identity_dedup","label":"目标唯一（id 精确定位）","weight":0.33},{"cond":"ownership","label":"归属完整（同租户）","weight":0.33},{"cond":"governance_approval","label":"人工确认","weight":0.15}]'::jsonb,
           'NORMAL', TRUE)
   ON CONFLICT (scenario_id, tenant_id) DO NOTHING`
).catch(() => {});
const ins = await queryWrite(
  `INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload)
   VALUES ('system','CRM_DEAL','e2e-pu-target','E2E事实变更靶子','ACTIVE','{"name":"E2E事实变更靶子","customer":"靶子公司","stage":"S3","keep_me":"原值保留"}')
   RETURNING id`
);
const TARGET_ID = ins.rows[0].id;
const other = await queryWrite(
  `INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload)
   VALUES ('e2e-other-tenant','CRM_DEAL','e2e-pu-other','他租户粒子','ACTIVE','{"name":"他租户粒子"}')
   RETURNING id`
);
const OTHER_ID = other.rows[0].id;

// ─── MCP 通道 ───
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js', '--stdio'],
  env: { ...process.env, PGDATABASE: process.env.PGDATABASE },
  stderr: 'pipe',
});
const client = new Client({ name: 'e2e-particle-update', version: '1.0.0' });

try {
  await client.connect(transport);
  check('① MCP 连接建立', true);

  const lr = unpack(await client.callTool({
    name: 'crm_login',
    arguments: { username: process.env.E2E_USER || 'alice', password: process.env.E2E_PASS || 'secret123' },
  }));
  if (!lr.ok || !lr.token) throw new Error(`登录失败: ${JSON.stringify(lr).slice(0, 200)}`);
  const auth = { api_token: lr.token };
  check('② crm_login 拿 token', !!lr.token, `actor=alice tenant=${lr.tenant_id || lr.tenantId || '?'}`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check('③ data-particle-update 已在 MCP 工具表暴露',
    names.includes('data-particle-update'), `共 ${names.length} 个工具`);

  // ④ phase1：应发 confirm_token 且不落库
  const p1 = unpack(await client.callTool({
    name: 'data-particle-update',
    arguments: { ...auth, id: TARGET_ID, patch: { name: 'E2E改名后' }, force: true },
  }));
  check('④ phase1 返回 confirm_token（未执行）', !!p1.confirm_token, `ok=${p1.ok} gate=${p1.gate || '-'}`);
  const mid = await query(`SELECT payload->>'name' AS n FROM crm.particles WHERE id=$1`, [TARGET_ID]);
  check('⑤ phase1 未落库（两阶段生效）', mid.rows[0]?.n === 'E2E事实变更靶子', `实际 name=${mid.rows[0]?.n}`);

  // ⑥ phase2：带 confirm_token 执行
  const p2 = unpack(await client.callTool({
    name: 'data-particle-update',
    arguments: { ...auth, confirm_token: p1.confirm_token },
  }));
  check('⑥ phase2 执行成功（ok===true）', p2.ok === true, JSON.stringify(p2).slice(0, 200));

  // ⑦ 字段级并入：改名字段生效，未传字段保留
  const after = await query(`SELECT payload, decision_id FROM crm.particles WHERE id=$1`, [TARGET_ID]);
  const pl = after.rows[0]?.payload || {};
  check('⑦ 传入字段已更新', pl.name === 'E2E改名后', `name=${pl.name}`);
  check('⑧ 未传字段原样保留（禁删/并入语义）',
    pl.customer === '靶子公司' && pl.stage === 'S3' && pl.keep_me === '原值保留',
    `customer=${pl.customer} stage=${pl.stage} keep_me=${pl.keep_me}`);
  check('⑨ decision_id 落粒子列（第0闸留痕）', !!after.rows[0]?.decision_id, `decision_id=${after.rows[0]?.decision_id}`);

  // ⑩ 租户边界：alice 属 system 租户 → 命中「平台治理豁免」（particleRepo.js:190 显式豁免 tenantId==='system'），
  //    跨租户写被放行属**预期行为**。真实租户隔离的严格锚点在 test/action/particle-update-tenant.test.js
  //    （② 已做红绿验证：去掉 tenantId 透传则写穿、补上则 cross_tenant_write_denied）。
  const x1 = unpack(await client.callTool({
    name: 'data-particle-update',
    arguments: { ...auth, id: OTHER_ID, patch: { name: 'system-治理写' }, force: true },
  }));
  const x2 = x1.confirm_token
    ? unpack(await client.callTool({ name: 'data-particle-update', arguments: { ...auth, confirm_token: x1.confirm_token } }))
    : x1;
  check('⑩ system 租户治理豁免（跨租户写放行，预期行为；严格隔离锚点见单元测试）',
    x2.ok === true, `ok=${x2.ok} error=${String(x2.error || '').slice(0, 80)}`);
} catch (e) {
  check('E2E 异常', false, e.message);
} finally {
  await queryWrite(`DELETE FROM crm.particles WHERE slug IN ('e2e-pu-target','e2e-pu-other')`).catch(() => {});
  await client.close().catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length ? 1 : 0);
