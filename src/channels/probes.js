// src/channels/probes.js — P4 真实通道探测实现（verifyScope 的「真探测」落点）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §4.5.1 步骤② / §3.1–§3.4 descriptor
// 红线（§4.5.1）：
//   ① **不 mock 代真**——每个探针必须真的发起连接（TCP/TLS 或 HTTPS）并按协议解析对端响应；
//      本地桩服务可用于**验证探针本身**，但生产路径不会把「对端是桩」当作「已接通」。
//   ② **未接通不得宣称已接通**——连接/认证/协议任一失败 → ok:false 且给出可区分的错误码
//      （connect_failed / auth_failed / protocol_invalid / probe_timeout / credentials_incomplete）。
//   ③ **凭据不回传**——探测结果只回结构化判定（如 expires_in、displayname 数量），
//      绝不回传 token / 密码 / 原文摘要（明文不落响应与日志，对齐 credentialVault 红线）。
//   ④ **超时受控**——任何探针都不得挂死（同步调度线程被单通道拖死是真实事故）。
// 零新增依赖：net/tls（IMAP）+ 全局 fetch（CalDAV/会议/企微）。
import net from 'node:net';
import tls from 'node:tls';

export const PROBE_TIMEOUT_MS = 8000;

// 凭据字段要求（**单一事实源**）：凭据不足 → credentials_incomplete + missing 列表。
// 为什么必须显式列出：设计 §3.1/§3.2/§3.4 的 descriptor 分别要求
//   imap {host,port,tls,user,pass} / caldav {url,auth} / wecom {corpId,agentId,auth}；
//   若探针在缺字段时硬连（猜 host、空 secret），得到的是「认证失败」而非「凭据不全」，
//   用户看到的是「邮箱密码错了」——误导修正方向，属**假失败**（比假绿更隐蔽）。
export const PROBE_REQUIRED_FIELDS = Object.freeze({
  imap_login: ['host', 'user', 'pass'],
  caldav_propfind: ['url'],
  meeting_api_list: ['endpoint', 'token'],
  wecom_api: ['corp_id', 'secret'],
});

function missingOf(name, c = {}) {
  const need = PROBE_REQUIRED_FIELDS[name] || [];
  return need.filter((k) => {
    const v = c[k];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
}

// 统一收口：任何探针都不许抛出（verifyScope 已再包一层，但探针自身也不许靠调用方兜底）
function guard(name, fn) {
  return async (args = {}) => {
    const c = args.credentials || {};
    const miss = missingOf(name, c);
    if (miss.length) {
      return { ok: false, probe: name, error: 'credentials_incomplete', missing: miss };
    }
    const ms = Number(args.timeoutMs || PROBE_TIMEOUT_MS);
    try {
      const r = await fn(c, ms);
      return { probe: name, ...r };
    } catch (e) {
      const code = e?.name === 'TimeoutError' || e?.code === 'ABORT_ERR' ? 'probe_timeout'
        : (e?.code ? `connect_failed:${e.code}` : `probe_error:${String(e?.message || e).slice(0, 200)}`);
      return { ok: false, probe: name, error: code };
    }
  };
}

// ── ① imap_login：真 TCP/TLS + IMAP4rev1 LOGIN ──────────────────────────────
// 协议：S: `* OK ...` greeting → C: `A1 LOGIN "user" "pass"` → S: `A1 OK ...`
// 判定：greeting 非 `* OK`/`* PREAUTH` → protocol_invalid（不是 IMAP 服务）；
//       `A1 NO`/`A1 BAD` → auth_failed（凭据错）；`A1 OK` → 通过。
function imapLogin(c, ms) {
  const host = String(c.host).trim();
  const tlsOn = c.tls !== false;                       // 默认加密（993/IMAPS）
  const port = Number(c.port || (tlsOn ? 993 : 143)) || (tlsOn ? 993 : 143);
  const user = String(c.user);
  const pass = String(c.pass);
  // IMAP 字面量需引号包裹并转义内部引号/反斜杠
  const q = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  // NO/BAD 行的原因透传（2026-09-18）：此前只回 `auth_failed`，把服务端原话吞掉 →
  //   163/126/QQ 的真实原因是「需用客户端授权码」，服务端 NO 行也确实写了 `Login error or password error`，
  //   但用户看到裸 `auth_failed` 只会去改密码，方向被误导（**假失败**：真因是授权机制不是密码）。
  //   ⚠ 必须脱敏：服务端可能回显我们发送的用户名/片段，任何出现在凭据里的字面量一律抹掉。
  const hint = (line) => {
    const raw = String(line || '').replace(/\r?\n/g, ' ').slice(0, 200);
    return [String(c.user), String(c.pass), String(c.host)]
      .filter((s) => s && s.length >= 3)
      .reduce((acc, s) => acc.split(s).join('<redacted>'), raw);
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = '';
    let phase = 'greeting';
    const sock = tlsOn
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: c.rejectUnauthorized !== false })
      : net.connect({ host, port });
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* 关闭失败不影响判定 */ }
      resolve(r);
    };
    sock.setEncoding('utf8');
    sock.setTimeout(ms);
    sock.on('error', (e) => { settled = true; try { sock.destroy(); } catch { /* noop */ } reject(e); });
    sock.on('timeout', () => finish({ ok: false, error: 'probe_timeout' }));
    sock.on('close', () => { if (!settled) finish({ ok: false, error: 'connection_closed' }); });
    sock.on('data', (chunk) => {
      buf += chunk;
      // 按整行消费（IMAP 行以 CRLF 结束；对端可能一次发多行）
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (phase === 'greeting') {
          if (/^\*\s+(OK|PREAUTH)\b/i.test(line)) {
            phase = 'login';
            sock.write(`A1 LOGIN ${q(user)} ${q(pass)}\r\n`);
          } else if (/^\*\s+BYE\b/i.test(line)) {
            finish({ ok: false, error: 'server_bye' });
          } else {
            finish({ ok: false, error: 'protocol_invalid', detail: 'greeting 不是 IMAP OK/PREAUTH' });
          }
        } else if (phase === 'login') {
          if (/^A1\s+OK\b/i.test(line)) finish({ ok: true, detail: { host, port, tls: tlsOn } });
          else if (/^A1\s+(NO|BAD)\b/i.test(line)) finish({ ok: false, error: 'auth_failed', hint: hint(line) });
          else if (/^A1\b/i.test(line)) finish({ ok: false, error: 'auth_failed', hint: hint(line) });
        }
      }
    });
  });
}

// ── ② caldav_propfind：真 HTTPS + WebDAV PROPFIND ───────────────────────────
// 协议：PROPFIND url (Depth: 0) → 207 Multi-Status 为真日历服务端；
//       401/403 → auth_failed；其余 → http_<status>。
async function caldavPropfind(c, ms) {
  const url = String(c.url).trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid_url' };
  const headers = { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' };
  if (c.user && c.pass) {
    headers.Authorization = 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64');
  }
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:prop><d:displayname /><d:current-user-principal /><c:calendar-home-set /></d:prop></d:propfind>';
  const r = await fetch(url, {
    method: 'PROPFIND', headers, body, redirect: 'manual', signal: AbortSignal.timeout(ms),
  });
  if (r.status === 207) return { ok: true, detail: { status: 207 } };
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed', detail: { status: r.status } };
  return { ok: false, error: `http_${r.status}`, detail: { status: r.status } };
}

// ── ③ meeting_api_list：真 HTTPS + 会议列表接口（Zoom/Teams/腾讯会议通用）──────
// 为什么是「endpoint + token」而非厂商专属：三家均为 token-flow（预设 auth.type='token-flow'），
//   厂商差异由租户 descriptor 的 endpoint 承载（零通道专属代码红线 R3）。
// 判定：2xx → 通过（顺带回报条数，证明**真的取到了数据**而非只连通）；
//       401/403 → auth_failed。
async function meetingApiList(c, ms) {
  const endpoint = String(c.endpoint).trim();
  if (!/^https?:\/\//i.test(endpoint)) return { ok: false, error: 'invalid_endpoint' };
  const r = await fetch(endpoint, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${c.token}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(ms),
  });
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed', detail: { status: r.status } };
  if (r.status >= 200 && r.status < 300) {
    let count = null;
    try {
      const j = await r.json();
      const arr = Array.isArray(j?.meetings) ? j.meetings : Array.isArray(j?.data) ? j.data : null;
      if (Array.isArray(arr)) count = arr.length;
    } catch { /* 响应非 JSON：连通已证，条数不可知（不因此判失败） */ }
    return { ok: true, detail: { status: r.status, meetings: count } };
  }
  return { ok: false, error: `http_${r.status}`, detail: { status: r.status } };
}

// ── ④ wecom_api：真 HTTPS + 企微 gettoken ───────────────────────────────────
// 协议：GET /cgi-bin/gettoken?corpid&corpsecret → errcode 0 为真授权。
// ⚠ 只回 expires_in：**绝不回传 access_token**（凭据不落响应/日志，红线③）。
async function wecomApi(c, ms) {
  const base = (c.base && String(c.base).trim()) || 'https://qyapi.weixin.qq.com';
  const u = new URL('/cgi-bin/gettoken', base);
  u.searchParams.set('corpid', String(c.corp_id));
  u.searchParams.set('corpsecret', String(c.secret));
  const r = await fetch(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(ms) });
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'auth_failed', detail: { status: r.status } };
  let j = null;
  try { j = await r.json(); } catch { return { ok: false, error: `http_${r.status}`, detail: { status: r.status } }; }
  if (Number(j?.errcode) === 0) return { ok: true, detail: { expires_in: j?.expires_in ?? null } };
  return { ok: false, error: `wecom_errcode_${j?.errcode ?? 'unknown'}`, detail: { errmsg: j?.errmsg ?? null } };
}

// 内建探针表（name → 已收口函数）
export const CHANNEL_PROBE_IMPLS = Object.freeze({
  imap_login: guard('imap_login', imapLogin),
  caldav_propfind: guard('caldav_propfind', caldavPropfind),
  meeting_api_list: guard('meeting_api_list', meetingApiList),
  wecom_api: guard('wecom_api', wecomApi),
});

// 显式注入点：把内建探针注册进某个 registry（如 verifyScope 的 registerChannelProbe）。
// ⚠ 刻意**不**在本模块内反向 import verifyScope：那会形成循环依赖（verifyScope 需静态取
//   CHANNEL_PROBE_IMPLS 作生产默认）。生产默认由 verifyScope 的 `builtin` 开关承载，
//   本函数只服务于「显式注入到另一个 registry」的场景（测试/旁路装配）。
export function registerBuiltinProbes(register) {
  if (typeof register !== 'function') throw new Error('registerBuiltinProbes 需要 register 函数');
  for (const [name, fn] of Object.entries(CHANNEL_PROBE_IMPLS)) register(name, fn);
  return Object.keys(CHANNEL_PROBE_IMPLS);
}
