// test/channels/probes.test.js — P4 真实探针的**真协议**验证
// 为什么不用 vi.mock(fetch)：那只能证明「代码调用了 fetch」，证明不了「发的包对不对、响应解析对不对」。
//   探针的全部价值在于**协议正确性**（IMAP 状态机 / PROPFIND 方法 / 企微 errcode 判定），
//   故本测试起**本地真服务端**（TCP for IMAP、HTTP for CalDAV/会议/企微），让探针真连真解析。
//   对端是本地桩 ≠ 生产假绿：桩只用于验证探针本身；生产路径连的是租户真实 endpoint。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { CHANNEL_PROBE_IMPLS, PROBE_REQUIRED_FIELDS, registerBuiltinProbes } from '../../src/channels/probes.js';

// ── 桩服务端：IMAP（真 TCP）────────────────────────────────────────────────
let imapSrv;
let imapPort;
const imapSeen = [];              // 记录桩收到的每一行（用于证明探针**真的发了 LOGIN**）
let imapMode = 'ok';              // ok | no | bye | garbage | silent

beforeAll(async () => {
  imapSrv = net.createServer((sock) => {
    sock.setEncoding('utf8');
    if (imapMode === 'silent') return;                 // 不发 greeting → 探针应超时
    if (imapMode === 'garbage') { sock.write('hello there\r\n'); return; }
    if (imapMode === 'bye') { sock.write('* BYE too many connections\r\n'); return; }
    sock.write('* OK IMAP4rev1 server ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        imapSeen.push(line);
        if (/^A1\s+LOGIN\b/i.test(line)) {
          if (imapMode === 'ok') sock.write('A1 OK LOGIN completed\r\n');
          else sock.write('A1 NO Authentication failed\r\n');
        }
      }
    });
  });
  await new Promise((r) => imapSrv.listen(0, '127.0.0.1', r));
  imapPort = imapSrv.address().port;

  httpSrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    httpSeen.push({ method: req.method, path: u.pathname, query: u.search, auth: req.headers.authorization || null, depth: req.headers.depth || null });
    if (u.pathname === '/caldav-ok') { res.writeHead(207, { 'Content-Type': 'application/xml' }); res.end('<multistatus/>'); }
    else if (u.pathname === '/caldav-401') { res.writeHead(401); res.end('no auth'); }
    else if (u.pathname === '/caldav-500') { res.writeHead(500); res.end('boom'); }
    else if (u.pathname === '/meetings-ok') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ meetings: [{ id: 1 }, { id: 2 }] })); }
    else if (u.pathname === '/meetings-403') { res.writeHead(403); res.end('denied'); }
    else if (u.pathname === '/cgi-bin/gettoken') {
      if (u.searchParams.get('corpsecret') === 'right') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: 'SECRET_TOKEN_SHOULD_NOT_LEAK', expires_in: 7200 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 40001, errmsg: 'invalid credential' }));
      }
    } else { res.writeHead(404); res.end('nope'); }
  });
  await new Promise((r) => httpSrv.listen(0, '127.0.0.1', r));
  httpPort = httpSrv.address().port;
});

let httpSrv;
let httpPort;
const httpSeen = [];

afterAll(async () => {
  await new Promise((r) => imapSrv.close(r));
  await new Promise((r) => httpSrv.close(r));
});

const B = `http://127.0.0.1:${0}`; // 占位，实际用 httpBase()
const httpBase = () => `http://127.0.0.1:${httpPort}`;

describe('探针契约：凭据不足必须如实区分（不得伪装成认证失败）', () => {
  it('四探针缺字段 → credentials_incomplete + missing（误导修正方向属假失败）', async () => {
    for (const [name, fn] of Object.entries(CHANNEL_PROBE_IMPLS)) {
      const r = await fn({ credentials: {} });
      expect(r.ok, `${name} 空凭据竟通过`).toBe(false);
      expect(r.error).toBe('credentials_incomplete');
      expect(r.missing).toEqual(PROBE_REQUIRED_FIELDS[name]);
    }
  });

  it('空白字符串等同缺失（"  " 不得被当成有效凭据）', async () => {
    const r = await CHANNEL_PROBE_IMPLS.imap_login({ credentials: { host: '  ', user: 'a@b.com', pass: 'x' } });
    expect(r.error).toBe('credentials_incomplete');
    expect(r.missing).toEqual(['host']);
  });
});

describe('imap_login：真 TCP + IMAP4rev1 状态机', () => {
  it('正常登录 → ok，且桩真的收到了 LOGIN 命令（证明不是 mock）', async () => {
    imapMode = 'ok';
    imapSeen.length = 0;
    const r = await CHANNEL_PROBE_IMPLS.imap_login({
      credentials: { host: '127.0.0.1', port: imapPort, tls: false, user: 'u@corp.com', pass: 'pw' },
    });
    expect(r.ok).toBe(true);
    expect(r.probe).toBe('imap_login');
    expect(imapSeen.some((l) => /^A1 LOGIN "u@corp\.com" "pw"$/.test(l)), `桩未见 LOGIN: ${JSON.stringify(imapSeen)}`).toBe(true);
  });

  it('凭据错（A1 NO）→ auth_failed（不是 connect_failed）', async () => {
    imapMode = 'no';
    const r = await CHANNEL_PROBE_IMPLS.imap_login({
      credentials: { host: '127.0.0.1', port: imapPort, tls: false, user: 'u@corp.com', pass: 'bad' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('auth_failed');
  });

  it('对端不是 IMAP（greeting 非法）→ protocol_invalid', async () => {
    imapMode = 'garbage';
    const r = await CHANNEL_PROBE_IMPLS.imap_login({ credentials: { host: '127.0.0.1', port: imapPort, tls: false, user: 'u', pass: 'p' } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('protocol_invalid');
  });

  it('服务端 BYE → server_bye（与「凭据错」区分）', async () => {
    imapMode = 'bye';
    const r = await CHANNEL_PROBE_IMPLS.imap_login({ credentials: { host: '127.0.0.1', port: imapPort, tls: false, user: 'u', pass: 'p' } });
    expect(r.error).toBe('server_bye');
  });

  it('对端静默 → probe_timeout（不挂死：超时受控是硬要求）', async () => {
    imapMode = 'silent';
    const t0 = Date.now();
    const r = await CHANNEL_PROBE_IMPLS.imap_login({
      credentials: { host: '127.0.0.1', port: imapPort, tls: false, user: 'u', pass: 'p' },
      timeoutMs: 400,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('probe_timeout');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('端口无监听 → connect_failed（不吞异常、不误报 auth_failed）', async () => {
    const r = await CHANNEL_PROBE_IMPLS.imap_login({
      credentials: { host: '127.0.0.1', port: 1, tls: false, user: 'u', pass: 'p' },
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/connect_failed|probe_error|probe_timeout/);
    expect(r.error).not.toBe('auth_failed');
  });

  it('密码含引号/反斜杠 → 按 IMAP 字面量转义后仍能登录（防注入 IMAP 命令）', async () => {
    imapMode = 'ok';
    imapSeen.length = 0;
    const r = await CHANNEL_PROBE_IMPLS.imap_login({
      credentials: { host: '127.0.0.1', port: imapPort, tls: false, user: 'u@corp.com', pass: 'a"b\\c' },
    });
    expect(r.ok).toBe(true);
    expect(imapSeen.some((l) => l.includes('a\\"b\\\\c'))).toBe(true);
  });
});

describe('caldav_propfind：真 HTTP PROPFIND', () => {
  it('207 Multi-Status → ok，且请求方法/深度头正确', async () => {
    httpSeen.length = 0;
    const r = await CHANNEL_PROBE_IMPLS.caldav_propfind({ credentials: { url: `${httpBase()}/caldav-ok` } });
    expect(r.ok).toBe(true);
    const seen = httpSeen.find((s) => s.path === '/caldav-ok');
    expect(seen.method).toBe('PROPFIND');
    expect(seen.depth).toBe('0');
  });

  it('401 → auth_failed；500 → http_500（故障可区分）', async () => {
    const a = await CHANNEL_PROBE_IMPLS.caldav_propfind({ credentials: { url: `${httpBase()}/caldav-401` } });
    expect(a.error).toBe('auth_failed');
    const b = await CHANNEL_PROBE_IMPLS.caldav_propfind({ credentials: { url: `${httpBase()}/caldav-500` } });
    expect(b.error).toBe('http_500');
  });

  it('user/pass 存在时发 Basic 认证头（凭据不外泄到 URL）', async () => {
    httpSeen.length = 0;
    await CHANNEL_PROBE_IMPLS.caldav_propfind({
      credentials: { url: `${httpBase()}/caldav-ok`, user: 'u@corp.com', pass: 'pw' },
    });
    const seen = httpSeen.find((s) => s.path === '/caldav-ok');
    expect(seen.auth).toMatch(/^Basic /);
    expect(Buffer.from(seen.auth.slice(6), 'base64').toString()).toBe('u@corp.com:pw');
  });

  it('非法 URL → invalid_url（不发起请求）', async () => {
    const r = await CHANNEL_PROBE_IMPLS.caldav_propfind({ credentials: { url: 'ftp://x/y' } });
    expect(r.error).toBe('invalid_url');
  });
});

describe('meeting_api_list：真 HTTP + 条数证明取到数据', () => {
  it('2xx → ok 且回报 meetings 条数（连通 ≠ 取到数据，条数是反证）', async () => {
    const r = await CHANNEL_PROBE_IMPLS.meeting_api_list({
      credentials: { endpoint: `${httpBase()}/meetings-ok`, token: 'tk' },
    });
    expect(r.ok).toBe(true);
    expect(r.detail.meetings).toBe(2);
  });

  it('403 → auth_failed', async () => {
    const r = await CHANNEL_PROBE_IMPLS.meeting_api_list({ credentials: { endpoint: `${httpBase()}/meetings-403`, token: 'tk' } });
    expect(r.error).toBe('auth_failed');
  });

  it('Bearer token 真的进了 Authorization 头', async () => {
    httpSeen.length = 0;
    await CHANNEL_PROBE_IMPLS.meeting_api_list({ credentials: { endpoint: `${httpBase()}/meetings-ok`, token: 'T-123' } });
    expect(httpSeen.find((s) => s.path === '/meetings-ok').auth).toBe('Bearer T-123');
  });
});

describe('wecom_api：企微 gettoken 真判定 + 凭据不回传', () => {
  it('errcode 0 → ok，且**绝不回传 access_token**（红线③）', async () => {
    const r = await CHANNEL_PROBE_IMPLS.wecom_api({
      credentials: { corp_id: 'ww123', secret: 'right', base: httpBase() },
    });
    expect(r.ok).toBe(true);
    expect(r.detail.expires_in).toBe(7200);
    expect(JSON.stringify(r)).not.toContain('SECRET_TOKEN_SHOULD_NOT_LEAK');
    expect(JSON.stringify(r)).not.toContain('right');
  });

  it('errcode 40001 → wecom_errcode_40001（含 errmsg 便于定位）', async () => {
    const r = await CHANNEL_PROBE_IMPLS.wecom_api({
      credentials: { corp_id: 'ww123', secret: 'wrong', base: httpBase() },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('wecom_errcode_40001');
    expect(r.detail.errmsg).toBe('invalid credential');
  });

  it('corpid/corpsecret 真的作为查询参数发出', async () => {
    httpSeen.length = 0;
    await CHANNEL_PROBE_IMPLS.wecom_api({ credentials: { corp_id: 'CID', secret: 'SEC', base: httpBase() } });
    const seen = httpSeen.find((s) => s.path === '/cgi-bin/gettoken');
    expect(seen.query).toContain('corpid=CID');
    expect(seen.query).toContain('corpsecret=SEC');
  });
});

describe('探针注册面', () => {
  it('registerBuiltinProbes 注入四个内建探针（registry 不再全 null）', () => {
    const got = {};
    const names = registerBuiltinProbes((n, f) => { got[n] = f; });
    expect(names.sort()).toEqual(['caldav_propfind', 'imap_login', 'meeting_api_list', 'wecom_api']);
    expect(Object.values(got).every((f) => typeof f === 'function')).toBe(true);
  });

  it('缺省 register 时拒绝静默（防止「注册了但没接上」的假绿）', () => {
    expect(() => registerBuiltinProbes()).toThrow();
  });

  it('内建探针名与 kinds.js 的 KIND_PROBE 值严格对应（多一个/少一个都会在运行时变 probe_not_implemented）', async () => {
    const { KIND_PROBE } = await import('../../src/channels/kinds.js');
    const probes = new Set(Object.values(KIND_PROBE));
    expect([...Object.keys(CHANNEL_PROBE_IMPLS)].sort()).toEqual([...probes].sort());
  });
});
