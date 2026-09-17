// src/sync/factory.js — 同步 provider 工厂（kind → 同步 provider 实例）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §6.1 A-B3 + §9.3
// ⚠ 与 connectors/discovery/tenantInstances.js 的 KIND_FACTORY **刻意分离**：
//   那边是 enrich 适配器契约（enrich + coverageFields，供 runWaterfall 富化瀑布消费）；
//   这边是同步 provider 契约（verifyAuth/discoverObjects/readIncremental，供 sync engine 消费）。
//   两者混用会让 runWaterfall 调到无 enrich 的实例 → 富化链路回归。
//   计划：docs/superpowers/plans/2026-09-16-line-a-mount-points.md §1 判断 1
//
// 🔴 红线（2026-09-17 重申，对齐 design §6 R3 + 用户"做成通用接口，不能按某产品深度定制"）：
//   本工厂**只承载一个实现** `generic-rest`。任何产品（Salesforce / 销售易 / 纷享逍客 / 自建 …）
//   的差异——endpoint / objects[] / 凭据 / 请求方法 / 鉴权流 / 响应形状——**全部由 descriptor
//   配置表达**（见 src/sync/presets/*.js 的纯数据预设），绝不在本文件写任何厂商专属代码。
//   历史上曾误建 `src/sync/fxiaoke.js`（产品专属深定制），已按 R3 删除；现改为 3 份预设。

// 通用 REST 同步 provider：零租户代码，差异全在 descriptor。
// 契约对齐 provider.js：verifyAuth() / discoverObjects() / readIncremental({object, cursor})。
// 通用能力（配置驱动，无产品名）：
//   - method: 'GET'（默认，查询参数组装）/ 'POST'（JSON body 组装）
//   - authHeader / authPrefix：静态鉴权头名与前缀（默认 Authorization: Bearer）——向后兼容
//   - auth: 通用鉴权抽象
//       type: 'static'（默认，直接用 token / credentials.token）
//       type: 'token-flow'：通用「链式请求」模型——steps[] 每步是一个 HTTP 请求，body 模板可引用
//             {cred.x}（凭据）与 {steps[i].var}（前序步骤输出）；tokenPath 提取本步 token，
//             outputVars 捕获中间字段（纷享逍客两步串联靠它）；最后一步的 token 作为最终令牌。
//             inject 决定 token 注入方式：header（默认 Authorization: Bearer）/ query / none（token 由 body 模板承载）
//   - request / response：请求与响应形状模板化（urlTemplate / bodyTemplate / rowsPath / cursorPath）
export function createGenericRestSyncProvider(cfg = {}) {
  const { endpoint, token, objects = [], method = 'GET', authHeader = 'Authorization', authPrefix = 'Bearer ' } = cfg;
  const cred = cfg.credentials || null;
  const doFetch = cfg.__fetch || ((url, opts) => fetch(url, opts));
  const authCfg = cfg.auth || null;
  const responseCfg = cfg.response || null;
  const inject = authCfg?.inject || { target: 'header', key: authHeader, prefix: authPrefix };

  // ---- 通用模板工具（无产品名）----
  function getPath(obj, path) {
    if (path == null) return undefined;
    if (typeof path === 'string' && path.startsWith('steps[')) {
      const m = path.match(/^steps\[(\d+)\]\.(\w+)$/);
      if (m) { const s = obj?.steps?.[Number(m[1])]; return s ? s[m[2]] : undefined; }
    }
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  // 扫描模板里引用的凭据键（{cred.x}）——用于「凭据缺失 fail-closed 零请求」前置校验
  function collectCredRefs(value, acc = new Set()) {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\{cred\.([\w.]+)\}/g)) acc.add(m[1]);
    } else if (Array.isArray(value)) {
      for (const v of value) collectCredRefs(v, acc);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) collectCredRefs(v, acc);
    }
    return acc;
  }
  function resolveTpl(value, ctx) {
    if (typeof value === 'string') {
      return value.replace(/\{([a-zA-Z_][\w.\[\]]*)\}/g, (_, p) => {
        const v = getPath(ctx, p);
        return v == null ? _ : String(v);
      });
    }
    if (Array.isArray(value)) return value.map((v) => resolveTpl(v, ctx));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolveTpl(v, ctx);
      return out;
    }
    return value;
  }

  // ---- 通用鉴权解析（static / token-flow）----
  async function authenticate() {
    // 静态：直接用 token（或 credentials.token）
    if (!authCfg || authCfg.type === 'static' || authCfg.type === undefined) {
      const t = token || (typeof cred === 'string' ? cred : cred?.token) || null;
      if (!t) return { ok: false, error: 'credentials_missing' };
      return { ok: true, token: t, base: cfg.base || endpoint || '' };
    }
    if (authCfg.type === 'token-flow') {
      const steps = authCfg.steps || [];
      if (!steps.length) return { ok: false, error: 'auth_no_steps' };
      // 凭据缺失 → fail-closed **零请求**：先校验模板引用的 {cred.x} 是否齐备
      for (const k of collectCredRefs(steps)) {
        const v = k.split('.').reduce((o, kk) => (o == null ? undefined : o[kk]), cred);
        if (v == null) return { ok: false, error: 'credentials_missing' };
      }
      const stepOuts = [];
      let tk = null;
      let lastJson = null;
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const ctx = { cred, steps: stepOuts, token: tk };
        const url = resolveTpl(step.url, ctx);
        const body = resolveTpl(step.body || {}, ctx);
        const resp = await doFetch(url, {
          method: step.method || 'POST',
          headers: { 'Content-Type': 'application/json', ...(step.headers || {}) },
          body: JSON.stringify(body),
        });
        if (!resp.ok) return { ok: false, error: `auth_step_${i}_http_${resp.status}` };
        const j = await resp.json();
        lastJson = j;
        const out = {};
        if (step.tokenPath) out.token = getPath(j, step.tokenPath);
        if (step.outputVars) for (const [k, p] of Object.entries(step.outputVars)) out[k] = getPath(j, p);
        stepOuts[i] = out;
        if (i === steps.length - 1) tk = out.token;
      }
      if (!tk) return { ok: false, error: 'auth_token_null' };
      const base = resolveTpl(cfg.base || endpoint || '', { cred, steps: stepOuts, token: tk });
      let expiresAt = null;
      const lastStep = steps[steps.length - 1];
      if (lastStep.expiresInPath && lastJson) {
        const secs = Number(getPath(lastJson, lastStep.expiresInPath));
        if (secs) expiresAt = Date.now() + secs * 1000;
      }
      return { ok: true, token: tk, base, stepOuts, expiresAt };
    }
    return { ok: false, error: `unknown_auth_type:${authCfg.type}` };
  }

  let _auth = null;
  async function ensureAuth() {
    if (_auth && (!_auth.expiresAt || _auth.expiresAt > Date.now())) return _auth;
    const r = await authenticate();
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error });
    _auth = r;
    return r;
  }

  async function verifyAuth() {
    if (!endpoint && !cfg.base) return { ok: false, error: 'endpoint_missing' };
    try {
      await ensureAuth();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.code || String(e.message || e) };
    }
  }

  async function discoverObjects() {
    const a = await verifyAuth();
    if (!a.ok) return { ok: false, error: a.error };
    return { ok: true, objects: objects.map((o) => ({ name: o.name, label: o.label || o.name })) };
  }

  // 增量：按 since_field 游标查询；游标推进到本批最大 since（无新记录则保持原游标 → 幂等）
  async function readIncremental({ object, cursor = null } = {}) {
    const auth = await ensureAuth();
    const def = objects.find((o) => o.name === object);
    if (!def) return { ok: false, error: `object_not_declared: ${object}`, rows: [], cursor };
    const since = def.since_field || 'updated_at';

    // 新路径：配置了 request.urlTemplate 或 token-flow 时用模板化请求
    const reqDef = def.request || {};
    const urlTpl = reqDef.urlTemplate || cfg.request?.urlTemplate;
    const bodyTpl = reqDef.bodyTemplate || cfg.request?.bodyTemplate;
    const httpMethod = reqDef.method || cfg.request?.method || method;
    const useTpl = !!urlTpl;

    const headers = {};
    let url;
    let body;
    if (useTpl) {
      const ctx = { cred, token: auth.token, base: auth.base, object, cursor, sinceField: since, steps: auth.stepOuts || [], ...def };
      // 两遍消解：第一遍解出 {base}/{soql} 等；第二遍消解 soql 等模板内嵌的 {cursor}/{token}
      url = resolveTpl(resolveTpl(urlTpl, ctx), ctx);
      if (httpMethod === 'POST') {
        const b = resolveTpl(resolveTpl(bodyTpl || {}, ctx), ctx);
        body = JSON.stringify(b);
        headers['Content-Type'] = 'application/json';
      }
    } else {
      // 旧路径（向后兼容既有测试契约）：静态 token + 简单游标查询
      if (httpMethod === 'POST') {
        body = JSON.stringify({ object, cursor, since_field: since, pageSize: def.page_size || 100 });
        headers['Content-Type'] = 'application/json';
        url = endpoint;
      } else {
        url = `${endpoint}?object=${encodeURIComponent(object)}&${encodeURIComponent(since)}=${encodeURIComponent(cursor || '')}`;
      }
    }

    // 注入 token（header / query / none）
    if (inject.target === 'query') {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}${inject.key}=${encodeURIComponent(`${inject.prefix || ''}${auth.token}`)}`;
    } else if (inject.target === 'header' || !inject.target) {
      headers[inject.key || authHeader] = `${inject.prefix || authPrefix || ''}${auth.token}`;
    }
    // inject.target === 'none' → 不注入（token 由 body 模板承载）

    try {
      const resp = await doFetch(url, { method: httpMethod, headers, ...(body ? { body } : {}) });
      if (!resp.ok) return { ok: false, error: `http_${resp.status}`, rows: [], cursor };
      const j = await resp.json();

      // 新路径响应提取
      if (useTpl && responseCfg) {
        const rowsRaw = responseCfg.rowsPath ? getPath(j, responseCfg.rowsPath) : j;
        const rows = Array.isArray(rowsRaw) ? rowsRaw : (Array.isArray(j) ? j : []);
        let nextCursor = cursor;
        if (responseCfg.cursorPath) { const cv = getPath(j, responseCfg.cursorPath); if (cv != null) nextCursor = cv; }
        else if (responseCfg.sincePath) { const cv = getPath(j, responseCfg.sincePath); if (cv != null) nextCursor = cv; }
        else {
          nextCursor = rows.reduce((m, r) => { const v = r?.[since]; return v && String(v) > String(m || '') ? v : m; }, null) || cursor;
        }
        return { ok: true, rows, cursor: nextCursor };
      }

      // 旧路径
      const rows = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
      const maxSince = rows.reduce((m, r) => {
        const v = r?.[since];
        return v && String(v) > String(m || '') ? v : m;
      }, null);
      return { ok: true, rows, cursor: maxSince || cursor };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), rows: [], cursor };
    }
  }

  return { kind: 'generic-rest', verifyAuth, discoverObjects, readIncremental };
}

export const SYNC_PROVIDER_FACTORY = {
  // 唯一真实现：纯配置驱动（endpoint / objects / 凭据 / 方法 / 鉴权流 / 响应形状）
  'generic-rest': createGenericRestSyncProvider,
  // 配置别名：销售易等同样走通用实现，零厂商代码（非深度定制）
  neocrm: createGenericRestSyncProvider,
};
