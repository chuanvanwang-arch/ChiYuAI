// scripts/e2e-mcp-doc-upload.mjs
// 线缆级 E2E：办公智能体经 MCP StreamableHTTP 管线完成「文档上传 → 挂接 CRM 粒子」
// 链路：crm_login(MCP工具) → POST /api/assets/upload(Staging,免confirm) →
//        crm-asset-attach 两阶段(MCP工具,过第0闸) → evidenced_by 边落库
// 仅测试库 crm_native_test；不触碰生产。运行：PGDATABASE=crm_native_test node scripts/e2e-mcp-doc-upload.mjs
import { createApp } from '../src/http/server.js';
import { startMcpHttp } from '../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { query, queryWrite } from '../src/db.js';
import { createParticle } from '../src/particles/particleRepo.js';

const API_PORT = Number(process.env.E2E_API_PORT || 3108);
const MCP_PORT = Number(process.env.E2E_MCP_PORT || 3107);
const SUF = Math.random().toString(36).slice(2, 8);
const USER = `e2e_agent_${SUF}`;
const PW = 'P@ssw0rd!';
const DUMMY_DECISION = 'e2e00000-0000-0000-0000-000000000001';

const log = (...a) => console.log('[e2e]', ...a);
const fail = (m) => { console.error('[e2e][FAIL]', m); };

let apiServer, mcpServer, client, transport;
let accountId = null, assetId = null, createdUserId = null;

async function cleanup() {
  try {
    if (accountId) await queryWrite(`DELETE FROM crm.edges WHERE source_id=$1 OR target_id=$1`, [accountId]).catch(() => {});
    if (assetId) await queryWrite(`DELETE FROM crm.particles WHERE id=$1`, [assetId]).catch(() => {});
    if (accountId) await queryWrite(`DELETE FROM crm.particles WHERE id=$1`, [accountId]).catch(() => {});
    if (createdUserId) await queryWrite(`DELETE FROM crm.crm_users WHERE username=$1`, [createdUserId]).catch(() => {});
  } catch (e) { log('cleanup err', e.message); }
  try { if (client) await client.close(); } catch {}
  try { if (mcpServer) mcpServer.close(); } catch {}
  try { if (apiServer) apiServer.close(); } catch {}
}

function assert(cond, msg) {
  if (!cond) { fail(msg); throw new Error(msg); }
  log('✓', msg);
}

async function main() {
  // ① 测试用户（sales 角色，MCP 需 crm_login）
  await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled)
     VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'E2EAgent', true)`,
    [USER, PW]
  );
  createdUserId = USER;

  // ② 启动 CRM HTTP API（承载 /api/assets/upload staging 端点）
  const apiApp = createApp();
  await new Promise((res) => { apiServer = apiApp.listen(API_PORT, res); });
  log(`CRM API 就绪 http://127.0.0.1:${API_PORT}`);

  // ③ 启动 MCP StreamableHTTP Server（办公智能体实际接入端口）
  const started = await startMcpHttp(MCP_PORT);
  mcpServer = started.httpServer;
  log(`MCP Server 就绪 http://127.0.0.1:${MCP_PORT}/mcp`);

  // ④ 办公智能体：MCP 客户端接入
  transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`));
  client = new Client({ name: 'e2e-office-agent', version: '1.0.0' });
  await client.connect(transport);
  log('MCP 客户端已连接（initialize 成功）');

  // ⑤ 步骤1：crm_login 领取结构化 token
  const loginRes = await client.callTool({ name: 'crm_login', arguments: { username: USER, password: PW } });
  const loginJson = JSON.parse(loginRes.content[0].text);
  assert(loginJson.token && /^crm_[0-9a-f]{32}_[0-9a-f]{48}$/.test(loginJson.token), 'crm_login 返回结构化 token');
  const token = loginJson.token;
  log('   token 前缀:', token.slice(0, 20) + '…');

  // ⑥ 步骤2：建业务目标粒子（客户）
  const acct = await createParticle('CRM_ACCOUNT', { name: `E2E挂接客户-${SUF}` }, { tenantId: 'system', actor: USER });
  accountId = acct.id;
  log('   目标客户粒子:', accountId);

  // ⑦ 步骤3：HTTP 上传文件（staging，免 confirm）→ asset_id
  const fileBuf = Buffer.from('e2e-contract-bytes-' + SUF);
  const upRes = await fetch(`http://127.0.0.1:${API_PORT}/api/assets/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': 'contract.pdf',
      'X-File-Mime': 'application/pdf',
    },
    body: fileBuf,
  });
  const upJson = await upRes.json();
  assert(upJson.ok && upJson.asset_id, 'HTTP 上传返回 asset_id（staging 落库）');
  assetId = upJson.asset_id;
  log('   asset_id:', assetId, 'sha256:', upJson.sha256?.slice(0, 12) + '…');

  // ⑧ 步骤4：crm-asset-attach 阶段1（带 decision_id 过第0闸）→ confirm_token
  const p1 = await client.callTool({
    name: 'crm-asset-attach',
    arguments: { asset_id: assetId, target_type: 'CRM_ACCOUNT', target_id: accountId, decision_id: DUMMY_DECISION, api_token: token },
  });
  const p1Json = JSON.parse(p1.content[0].text);
  assert(p1Json.ok && p1Json.confirm_token, 'crm-asset-attach 阶段1 颁发 confirm_token（第0闸通过）');
  const confirmToken = p1Json.confirm_token;
  log('   confirm_token:', confirmToken.slice(0, 16) + '…');

  // ⑨ 步骤5：crm-asset-attach 阶段2（confirm_token 确认执行）→ 落边
  const p2 = await client.callTool({
    name: 'crm-asset-attach',
    arguments: { confirm_token: confirmToken, api_token: token },
  });
  const p2Json = JSON.parse(p2.content[0].text);
  assert(p2Json.ok, 'crm-asset-attach 阶段2 执行成功');
  const p2Summary = String(p2Json.data?.summary || p2Json.summary || '');
  assert(p2Summary.includes('挂接'), '阶段2 返回业务语言摘要（含「挂接」）');
  log('   摘要:', p2Summary);

  // ⑩ 验证：evidenced_by 边真实落库 + meta 携带 decision_id
  const edge = await query(
    `SELECT * FROM crm.edges WHERE source_id=$1 AND edge_type='evidenced_by'`,
    [accountId]
  );
  assert(edge.rows.length === 1, 'evidenced_by 边已落库（source=客户, target=资产）');
  assert(edge.rows[0].target_id === assetId, '边 target 指向上传的资产粒子');
  assert(edge.rows[0].meta?.decision_id === DUMMY_DECISION, '边 meta 携带 decision_id（第0闸留痕）');
  assert(edge.rows[0].meta?.edge_source === 'manual', '边 meta.edge_source=manual');
  log('   边:', { source_type: edge.rows[0].source_type, edge_type: edge.rows[0].edge_type, target_type: edge.rows[0].target_type });

  console.log('\n✅ E2E 全链路通过：办公智能体经 MCP 线缆成功完成「文档上传 → 挂接 CRM 客户粒子」，evidenced_by 边已落库。');
}

main()
  .then(async () => { await cleanup(); log('done'); process.exit(0); })
  .catch(async (e) => { await cleanup(); console.error('\n❌ E2E 失败:', e.message); process.exit(1); });
