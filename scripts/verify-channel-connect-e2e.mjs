// scripts/verify-channel-connect-e2e.mjs — 通道接入**真链路**端到端验证（P4）
// 为什么需要：`test/http/channelRouter.test.js` 用替身 verifyScope，只能证明「router 调了 verifyScope」，
//   证明不了「凭据真的驱动了真实协议探测、且 verify_only 路径能拿到 verified:true」。
//   用户看到的效果（向导②「✅ 探测通过」）落在这条链路上，故必须**真连一次**。
// 做法：本地起真服务端（TCP=IMAP 桩、HTTP=CalDAV/会议/企微桩）→ 用**生产** createChannelRouter
//   + createVerifyScope（内建真实探针）+ 桩 reviewGate → 逐场景断言。
// ⚠ 对端是本地桩 ≠ 生产假绿：桩只用于让链路可重复执行；生产路径连的是租户真实 endpoint，
//   且探针全部按真实协议实现（见 test/channels/probes.test.js 的协议级验证与变异自证）。
// 支持 HOME_HTML 式变异：可用环境变量注入，但本脚本验证的是 src/*.js 链路，变异见 tmp/_mutate_probes.mjs。
import net from 'node:net';
import http from 'node:http';
import { createChannelRouter } from '../src/http/channelRouter.js';
import { createVerifyScope } from '../src/channels/verifyScope.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  🔴 ' + msg); } };

// ── 桩服务端 ───────────────────────────────────────────────────────────────
let imapMode = 'ok';
const imapSrv = net.createServer((sock) => {
  sock.setEncoding('utf8');
  if (imapMode === 'silent') return;
  sock.write('* OK IMAP4rev1 ready\r\n');
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (/^A1\s+LOGIN\b/i.test(line)) {
        sock.write(imapMode === 'ok' ? 'A1 OK LOGIN completed\r\n' : 'A1 NO Authentication failed\r\n');
      }
    }
  });
});
const httpSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/caldav') { res.writeHead(207); res.end('<multistatus/>'); }
  else if (u.pathname === '/meetings') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ meetings: [{ id: 1 }] })); }
  else if (u.pathname === '/cgi-bin/gettoken') {
    const good = u.searchParams.get('corpsecret') === 'right-secret';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(good
      ? JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: 'LEAK_CANARY', expires_in: 7200 })
      : JSON.stringify({ errcode: 40001, errmsg: 'invalid credential' }));
  } else { res.writeHead(404); res.end(); }
});

await new Promise((r) => imapSrv.listen(0, '127.0.0.1', r));
await new Promise((r) => httpSrv.listen(0, '127.0.0.1', r));
const imapPort = imapSrv.address().port;
const httpPort = httpSrv.address().port;
const HB = `http://127.0.0.1:${httpPort}`;

// ── 生产链路装配（与 routes.js 同构：内建真实探针 + 真 router）────────────────
const store = {};
const secrets = {};
const router = createChannelRouter({
  readConfig: async (key, { tenantId } = {}) => ({ value: store[`${tenantId}:${key}`] || null }),
  writeConfig: async (key, value, { tenantId, decisionId } = {}) => {
    store[`${tenantId}:${key}`] = value; store[`${tenantId}:${key}:decision`] = decisionId ?? null;
  },
  persistSecret: async ({ providerId, raw }) => { secrets[providerId] = raw; return { ok: true }; },
  reviewGate: { hasApproval: async () => ({ approved: true }) },   // 桩：人工闸放行（本脚本不验证人工闸）
  verifyScope: createVerifyScope({
    resolveCredentials: async ({ providerIds }) => Object.fromEntries(providerIds.map((p) => [p, secrets[p] ?? null])),
  }),
  produceDecision: async () => ({ decisionId: 'DEC-TEST' }),
});

function call(body) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return router.handlers.connect({ method: 'POST', body, query: {}, params: {}, headers: {} }, res).then(() => res);
}

console.log('\n场景 A：邮箱 verify_only → 真 IMAP LOGIN 探测通过（零副作用）');
{
  imapMode = 'ok';
  const res = await call({
    tenant_id: 'probe', id: 'channel-email-probe', kind: 'generic-email',
    credentials: { host: '127.0.0.1', port: imapPort, tls: false, user: 'u@corp.com', pass: 'pw' },
    trust_level: 'L1', verify_only: true,
  });
  ok(res.statusCode === 200, `HTTP 200（实为 ${res.statusCode}）`);
  ok(res.body?.verified === true, `verified:true（实为 ${JSON.stringify(res.body)}）`);
  ok(res.body?.probe === 'imap_login', `probe=imap_login（实为 ${res.body?.probe}）`);
  ok(res.body?.stored === false, '零副作用：stored=false');
  ok(secrets['channel-email-probe'] === undefined, '零副作用：凭据未落 vault');
  ok(store['probe:integration-providers'] === undefined, '零副作用：描述符未写');
}

console.log('\n场景 B：密码错 → auth_failed（不假绿，400 且给出可区分错误码）');
{
  imapMode = 'no';
  const res = await call({
    tenant_id: 'probe', id: 'channel-email-probe', kind: 'generic-email',
    credentials: { host: '127.0.0.1', port: imapPort, tls: false, user: 'u@corp.com', pass: 'wrong' },
    verify_only: true,
  });
  ok(res.statusCode === 400, `HTTP 400（实为 ${res.statusCode}）`);
  ok(res.body?.error === 'auth_failed', `error=auth_failed（实为 ${res.body?.error}）`);
}

console.log('\n场景 C：凭据不全 → credentials_incomplete + missing（不误导成「密码错」）');
{
  const res = await call({
    tenant_id: 'probe', id: 'channel-email-probe', kind: 'generic-email',
    credentials: { user: 'u@corp.com', pass: 'pw' },   // 缺 host
    verify_only: true,
  });
  ok(res.body?.error === 'credentials_incomplete', `error=credentials_incomplete（实为 ${res.body?.error}）`);
  ok(JSON.stringify(res.body?.missing) === '["host"]', `missing=["host"]（实为 ${JSON.stringify(res.body?.missing)}）`);
}

console.log('\n场景 D：确认接入（非 verify_only）→ 真探测 + 落库 + 决策留痕');
{
  imapMode = 'ok';
  const res = await call({
    tenant_id: 'probe', id: 'channel-email-probe', kind: 'generic-email',
    credentials: { host: '127.0.0.1', port: imapPort, tls: false, user: 'u@corp.com', pass: 'pw' },
    trust_level: 'L1',
  });
  ok(res.statusCode === 200, `HTTP 200（实为 ${res.statusCode}）`);
  ok(res.body?.stored === true, '已落库');
  ok(secrets['channel-email-probe']?.user === 'u@corp.com', '凭据已入 vault');
  ok(store['probe:integration-providers']?.[0]?.enabled === true, '描述符 enabled=true');
  ok(store['probe:integration-providers:decision'] === 'DEC-TEST', '决策 ID 落库（写无决策不留白）');
  ok(JSON.stringify(res.body).includes('pw') === false, '响应不回显明文凭据');
}

console.log('\n场景 E：四通道探针全部可被调用（无 probe_not_implemented）');
{
  const cases = [
    ['generic-calendar', { url: `${HB}/caldav` }, 'caldav_propfind'],
    ['generic-meeting', { endpoint: `${HB}/meetings`, token: 'tk' }, 'meeting_api_list'],
    ['generic-wechat', { corp_id: 'ww1', secret: 'right-secret', base: HB }, 'wecom_api'],
  ];
  for (const [kind, credentials, probe] of cases) {
    const res = await call({ tenant_id: 'probe', id: `ch-${kind}`, kind, credentials, verify_only: true });
    ok(res.statusCode === 200 && res.body?.probe === probe,
      `${kind} → ${probe}（实为 ${res.statusCode}/${res.body?.probe || res.body?.error}）`);
  }
  // 企微错密钥 → errcode 判定
  const bad = await call({ tenant_id: 'probe', id: 'ch-wx-bad', kind: 'generic-wechat', credentials: { corp_id: 'ww1', secret: 'bad', base: HB }, verify_only: true });
  ok(bad.body?.error === 'wecom_errcode_40001', `企微错密钥 → wecom_errcode_40001（实为 ${bad.body?.error}）`);
}

console.log('\n场景 F：凭据不回传（红线③：access_token 不得出现在响应里）');
{
  const res = await call({ tenant_id: 'probe', id: 'ch-wx', kind: 'generic-wechat', credentials: { corp_id: 'ww1', secret: 'right-secret', base: HB }, verify_only: true });
  ok(!JSON.stringify(res.body).includes('LEAK_CANARY'), '响应不含 access_token（LEAK_CANARY 未泄漏）');
  ok(!JSON.stringify(res.body).includes('right-secret'), '响应不含 corpsecret');
}

await new Promise((r) => imapSrv.close(r));
await new Promise((r) => httpSrv.close(r));

console.log(`\n${fail ? `🔴 ${fail} 项失败` : `✅ 全部通过（${pass} 项）`}`);
process.exit(fail ? 1 : 0);
