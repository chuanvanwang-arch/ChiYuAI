// src/sync/fxiaoke.js — 纷享销客 CrmProvider 适配器
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T02 + §9.3 + §6.1 A-B2
// 鉴权：appId+appSecret+permanentCode → CorpAccessToken（7200s）
// ⚠ token 缓存的唯一权威在 credentialVault 的加密落库槽（A-B2：不落内存全局）；
//   本适配器内的 tokenCache 仅为**单次进程内**的请求合并，进程重启即失效，不参与跨实例一致性。
// 契约三方法：verifyAuth/discoverObjects/readIncremental（对齐 provider.js）
export function createFxiaokeProvider({ creds = null, credentials = null, baseUrl = 'https://open.fxiaoke.com', httpPost, httpGet } = {}) {
  // 凭据来源二者取一：creds（历史签名）优先，其次 credentials（挂载层注入的归一化结构化凭据，A-B2/§9.3）
  const c = (creds && typeof creds === 'object' && Object.keys(creds).length)
    ? creds
    : (credentials && typeof credentials === 'object' && !Array.isArray(credentials) ? credentials : {});
  let tokenCache = null;
  let tokenExpiresAt = 0;

  async function corpAccessToken() {
    if (tokenCache && Date.now() < tokenExpiresAt) return { ok: true, token: tokenCache };
    const body = {
      appId: c.appId,
      appSecret: c.appSecret,
      permanentCode: c.permanentCode,
      grantType: 'client_credentials',
    };
    const post = httpPost || (async (url, payload) => {
      const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!resp.ok) throw new Error(`fxiaoke auth http ${resp.status}`);
      return resp.json();
    });
    try {
      const j = await post(`${baseUrl}/cgi/corpAccessToken/get`, body);
      if (!j.access_token) return { ok: false, error: `fxiaoke 未返回 access_token: ${JSON.stringify(j).slice(0, 200)}` };
      tokenCache = j.access_token;
      tokenExpiresAt = Date.now() + (Number(j.expires_in || 7200) - 60) * 1000;
      return { ok: true, token: tokenCache };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async function verifyAuth() { return corpAccessToken(); }

  async function discoverObjects() {
    const auth = await corpAccessToken();
    if (!auth.ok) return { ok: false, error: auth.error };
    const get = httpGet || (async (url, headers) => {
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`fxiaoke object list http ${resp.status}`);
      return resp.json();
    });
    try {
      const j = await get(`${baseUrl}/cgi/crm/object/list`, { 'access_token': auth.token });
      const list = (j.data || j.objects || []).map(o => ({ name: o.apiName || o.api_name, label: o.label || o.name }));
      return { ok: true, objects: list };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // 增量读取（真实实现，2026-09-16 P0-2 去桩）
  // 官方接口（多来源实证）：POST {baseUrl}/cgi/crm/v2/data/query
  //   body { corpAccessToken, corpId, currentOpenUserId,
  //          data: { dataObjectApiName, search_query_info: { limit, offset, filters:[{field_name, field_values, operator}] } } }
  //   响应 { data: { total, offset, limit, dataList[] }, errorCode, errorMessage }
  // ⚠ 去假绿铁律：旧实现对任何输入恒返 { ok:true, rows:[], note:'...' } → engine 记 last_status='ok' +
  //   counts.read=0 →「同步在跑」与「一条都没读到」不可区分（F2）。本实现一律 fail-closed：
  //   缺 object / 缺凭据 / 业务错误码非 0 / HTTP 异常 → ok:false（由 engine 落 status='failed' 并留痕）。
  // 字段名可由接入凭据覆盖：sinceField（默认 last_modified_time）；记录主键由映射层 identity 声明。
  async function readIncremental({ object, cursor, pageSize = 100 } = {}) {
    const cur = cursor || null;
    if (!object) return { ok: false, error: 'object_missing', rows: [], cursor: cur };
    // v2/data/query 除 token 外必须携带 corpId / currentOpenUserId（官方 body 必填项）
    if (!c.corpId || !c.currentOpenUserId) {
      return { ok: false, error: 'fxiaoke_credentials_incomplete: corpId/currentOpenUserId 缺失', rows: [], cursor: cur };
    }
    const auth = await corpAccessToken();
    if (!auth.ok) return { ok: false, error: auth.error, rows: [], cursor: cur };
    const post = httpPost || (async (url, payload) => {
      const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!resp.ok) throw new Error(`fxiaoke query http ${resp.status}`);
      return resp.json();
    });
    const since = c.sinceField || 'last_modified_time';
    const filters = cur ? [{ field_name: since, field_values: [cur], operator: 'GTE' }] : [];
    try {
      const j = await post(`${baseUrl}/cgi/crm/v2/data/query`, {
        corpAccessToken: auth.token,
        corpId: c.corpId,
        currentOpenUserId: c.currentOpenUserId,
        data: {
          dataObjectApiName: object,
          search_query_info: { limit: Number(pageSize) || 100, offset: 0, filters },
        },
      });
      if (j?.errorCode !== undefined && Number(j.errorCode) !== 0) {
        return { ok: false, error: `fxiaoke_error_${j.errorCode}: ${j.errorMessage || ''}`, rows: [], cursor: cur };
      }
      const rows = Array.isArray(j?.data?.dataList) ? j.data.dataList : [];
      const maxSince = rows.reduce((m, r) => {
        const v = r?.[since];
        return v && String(v) > String(m || '') ? v : m;
      }, null);
      return { ok: true, rows, cursor: maxSince || cur, total: j?.data?.total ?? rows.length };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), rows: [], cursor: cur };
    }
  }

  return { kind: 'fxiaoke', verifyAuth, discoverObjects, readIncremental };
}
