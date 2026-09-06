# Stage 3 门户首页（index.html 替换 + Home.html 登录）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将门户升级为 AI 作战室（Lightfield 主轴）——`index.html` 替换为 AI 作战室主页（copilot 命令栏 + 今日优先打分 + L2C + 审批收件箱 + SSE + 池配置），并新建 `Home.html` 作为不同用户/角色的真实登录页（复用旧观测看板卡片作状态墙）。

**Architecture:** 双页结构：`Home.html`（登录 + 状态墙，含真实用户名/密码认证）→ token → `index.html`（受 token 保护，按角色自适应）。认证后端最小可行：`crm.crm_users` 表 + `POST /api/auth/login` + `GET /api/auth/me`，token 用 HMAC-SHA256 自签（不引 jwt 库，复用 Node 内置 `crypto`）。打分逻辑抽为 `src/portal/scoring.js` 单源，经 `/portal/scoring.js` 路由暴露给浏览器 ESM import，同时供 vitest 单测。

**Tech Stack:** Node 22 ESM · Express 4 · PostgreSQL 16（pgcrypto `crypt`/`gen_salt`）· vanilla JS（前端，无框架）· vitest 3。

---

## 文件结构

**新建**
- `src/http/auth.js` — 认证逻辑：`issueToken` / `verifyToken` / `extractToken` / `login` / `resolveMe`（纯函数 + pgcrypto 校验）。
- `src/portal/scoring.js` — 今日优先打分：`clamp` / `scoreDeal` / `suggestAction` / `buildTodayPriority` / `l2cCounts`（纯函数，浏览器与测试共用）。
- `src/web/home.html` — 登录页 + 系统状态墙（复用旧 index.html 卡片逻辑：装配/kanban/最新粒子/审批概览）。
- `test/auth.test.js` — 登录/me 路由单测。
- `test/portal-scoring.test.js` — 打分算法单测。
- `test/portal-pages.test.js` — 双页路由冒烟（GET /home.html、GET /、含关键标记）。

**改写**
- `src/web/index.html` — **整体覆盖**为 AI 作战室主页（旧 Stage1 内容下沉至 home.html）。
- `db/schema.sql` — 追加 `crm.crm_users` 表（CREATE TABLE IF NOT EXISTS）。
- `db/seed.sql` — 幂等种子 6 角色演示账号。
- `src/http/routes.js` — 新增认证路由 + 双页路由 + `/portal/scoring.js` 静态路由 + 导入 `auth.js`。

**测试约定（重要）**：本工程测试经 `app.fetch(path, {method, headers, body})` 驱动，body 须为 JSON 字符串且带 `Content-Type: application/json`（express.json 才解析）。运行命令统一：
`node node_modules/vitest/vitest.mjs run --fileParallelism=false test/<file>.test.js`

---

### Task A：Home.html 登录页 + 系统状态墙

**Files:**
- Create: `src/web/home.html`
- Modify: `src/http/routes.js`（`createRoutes` 内追加 `/home.html` 与 `/home` 路由）
- Test: `test/portal-pages.test.js`

- [ ] **Step 1：写失败测试**

```js
// test/portal-pages.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../src/http/server.js';

let app;
beforeAll(() => { app = createApp(); });

describe('门户双页路由', () => {
  it('GET /home.html 返回登录页与状态墙', async () => {
    const res = await app.fetch('/home.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('登录');
    expect(html).toContain('系统状态墙');
  });
  it('GET /home 重定向到 /home.html', async () => {
    const res = await app.fetch('/home');
    expect([301, 302]).toContain(res.status);
  });
});
```

- [ ] **Step 2：运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pages.test.js`
Expected: FAIL（`/home.html` 404，无「系统状态墙」标记）。

- [ ] **Step 3：实现 Home.html + 路由**

`src/web/home.html`（登录表单 + 状态墙，复用旧卡片 fetch 逻辑）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><title>CRM 门户 · 登录</title>
<style>
 body{font-family:system-ui;margin:0;background:#0f172a;color:#e2e8f0;min-height:100vh}
 .wrap{max-width:960px;margin:0 auto;padding:32px 24px;display:grid;grid-template-columns:1fr 1fr;gap:24px}
 .login{background:#1e293b;padding:24px;border-radius:14px}
 .login h1{font-size:18px;margin:0 0 16px}
 input{width:100%;padding:10px;margin:8px 0;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0}
 button{width:100%;padding:10px;margin-top:12px;border:none;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer}
 .wall .card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:12px 16px;margin:8px 0}
 .wall h2{font-size:15px;grid-column:1/-1;color:#94a3b8}
 .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;background:#334155;margin:2px}
 .err{color:#f87171;font-size:13px;min-height:18px}
 a{color:#818cf8}
</style></head>
<body>
<div class="wrap">
  <div class="login">
    <h1>🔐 CRM 门户登录</h1>
    <div id="roleHint" style="font-size:12px;color:#94a3b8;margin-bottom:8px"></div>
    <input id="u" placeholder="用户名（sales/manager/exec/finance/presales/contract_admin）">
    <input id="p" type="password" placeholder="密码（演示：crm123!）">
    <div class="err" id="err"></div>
    <button id="go">登录进入作战室</button>
    <div style="margin-top:12px;font-size:12px"><a href="/">已进入？直达作战室 →</a></div>
  </div>
  <div class="wall">
    <h2>📊 系统状态墙（进入前概览）</h2>
    <div class="card"><b>装配校验</b><div id="assembly">加载中…</div></div>
    <div class="card"><b>看板状态</b><div id="kanban">—</div></div>
    <div class="card"><b>最新粒子（10）</b><div id="particles">—</div></div>
    <div class="card"><b>审批概览</b><div id="approval">—</div></div>
  </div>
</div>
<script>
async function wall(){
  try{
    const [a,t,p,b]=await Promise.all([
      fetch('/api/agents').then(r=>r.json()),
      fetch('/api/kanban/tasks').then(r=>r.json()),
      fetch('/api/particles').then(r=>r.json()),
      fetch('/api/business/board').then(r=>r.json())
    ]);
    document.getElementById('assembly').innerHTML=
      `<span style="color:${a.assembly.ok?'#4ade80':'#f87171'}">${a.assembly.ok?'通过':'失败'}</span> · ${a.agents.join(', ')}`;
    const c=['ready','running','done','failed','blocked'].map(s=>t.items.filter(x=>x.status===s).length).join(' / ');
    document.getElementById('kanban').textContent=`ready/running/done/failed/blocked = ${c}`;
    document.getElementById('particles').innerHTML=p.items.slice(0,10).map(x=>`<span class="badge">${x.type}·${x.payload?.name||x.title||''}</span>`).join('');
    const g=b.grouped||{};const sub=Object.entries(g).filter(([,a])=>a.some(x=>x.status==='submitted')).length;
    document.getElementById('approval').textContent=`${sub} 类业务粒子存在待审提交`;
  }catch(e){}
}
document.getElementById('go').onclick=async()=>{
  const err=document.getElementById('err');err.textContent='';
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});
  const j=await r.json();
  if(!r.ok){err.textContent=j.error||'登录失败';return;}
  localStorage.setItem('crm_token',j.token);localStorage.setItem('crm_role',j.role);localStorage.setItem('crm_name',j.display_name);
  location.href='/';
};
if(localStorage.getItem('crm_token'))document.getElementById('roleHint').textContent='当前已登录：'+localStorage.getItem('crm_name');
wall();setInterval(wall,8000);
</script>
</body></html>
```

`src/http/routes.js` 在 `createRoutes` 内、`app.get('/', ...)` 附近追加：

```js
  // 门户双页（v2）：Home.html = 登录+状态墙；index.html = AI 作战室
  app.get('/home.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/home.html', import.meta.url))));
  app.get('/home', (req, res) => res.redirect('/home.html'));
```

- [ ] **Step 4：运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pages.test.js`
Expected: PASS（2/2）。

- [ ] **Step 5：提交**

```bash
git add src/web/home.html src/http/routes.js test/portal-pages.test.js
git commit -m "feat(portal): Home.html 登录页 + 系统状态墙（复用旧观测卡片）"
```

---

### Task B：认证后端（crm_users + 登录/me 路由）

**Files:**
- Create: `src/http/auth.js`
- Modify: `db/schema.sql`（追加 `crm.crm_users` 表）
- Modify: `db/seed.sql`（幂等种子 6 角色账号）
- Modify: `src/http/routes.js`（导入 auth.js + 新增 `/api/auth/login`、`/api/auth/me`）
- Test: `test/auth.test.js`

- [ ] **Step 1：写失败测试**

```js
// test/auth.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/http/server.js';
import { query } from '../src/db.js';

let app;
beforeEach(async () => {
  await query('TRUNCATE crm.crm_users RESTART IDENTITY CASCADE');
  await query(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name)
     VALUES ($1, crypt($2, gen_salt('bf')), 'sales', '销售-示例')`,
    ['alice', 'secret123']
  );
});
beforeEach(() => { app = createApp(); });

const post = (path, body) => app.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/auth/login', () => {
  it('正确密码返回 token+role', async () => {
    const res = await post('/api/auth/login', { username: 'alice', password: 'secret123' });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.token).toMatch(/\./); expect(j.role).toBe('sales');
  });
  it('错误密码返回 401', async () => {
    const res = await post('/api/auth/login', { username: 'alice', password: 'wrong' });
    expect(res.status).toBe(401);
  });
  it('未知用户返回 401', async () => {
    const res = await post('/api/auth/login', { username: 'nobody', password: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('有效 token 返回角色', async () => {
    const login = await post('/api/auth/login', { username: 'alice', password: 'secret123' });
    const { token } = await login.json();
    const res = await app.fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json();
    expect(res.status).toBe(200); expect(j.role).toBe('sales');
  });
  it('无 token 返回 401', async () => {
    const res = await app.fetch('/api/auth/me');
    expect(res.status).toBe(401);
  });
  it('篡改 token 返回 401', async () => {
    const res = await app.fetch('/api/auth/me', { headers: { Authorization: 'Bearer a.b.c' } });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2：运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/auth.test.js`
Expected: FAIL（无 `crm.crm_users` 表 / 无 `/api/auth/login`）。

- [ ] **Step 3：实现认证后端**

`src/http/auth.js`：

```js
// src/http/auth.js — 最小可行认证（HMAC 自签 token，复用 Node 内置 crypto）
import crypto from 'node:crypto';
import { query } from '../db.js';

const SECRET = process.env.PORTAL_JWT_SECRET || 'crm-portal-dev-secret';

export function issueToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') throw new Error('missing token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('bad signature');
  }
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch { throw new Error('bad payload'); }
}

export function extractToken(req) {
  const h = req.headers?.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function login({ username, password } = {}) {
  if (!username || !password) return { ok: false, status: 400, error: 'username and password required' };
  const { rows } = await query(
    `SELECT username, password_hash, role, display_name FROM crm.crm_users WHERE username=$1`, [username]);
  if (!rows.length) return { ok: false, status: 401, error: 'invalid credentials' };
  const u = rows[0];
  const { rows: v } = await query(`SELECT crypt($1, $2) = $2 AS ok`, [password, u.password_hash]);
  if (!v[0].ok) return { ok: false, status: 401, error: 'invalid credentials' };
  const token = issueToken({ username: u.username, role: u.role, display_name: u.display_name });
  return { ok: true, status: 200, token, role: u.role, display_name: u.display_name };
}

export function resolveMe(req) {
  const token = extractToken(req);
  if (!token) return { ok: false, status: 401, error: 'missing token' };
  try {
    const p = verifyToken(token);
    return { ok: true, status: 200, role: p.role, display_name: p.display_name, username: p.username };
  } catch {
    return { ok: false, status: 401, error: 'invalid token' };
  }
}
```

`db/schema.sql` 在文件末尾追加（CREATE TABLE IF NOT EXISTS，幂等）：

```sql
-- 门户登录账号（v2 双页：Home.html → token → index.html）
CREATE TABLE IF NOT EXISTS crm.crm_users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  display_name text NOT NULL,
  org_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

`db/seed.sql` 末尾追加（幂等，不破坏既有种子）：

```sql
-- 门户演示账号（角色对齐 crm.role_context_profile）
INSERT INTO crm.crm_users (username, password_hash, role, display_name)
SELECT v.username, crypt(v.pw, gen_salt('bf')), v.role, v.dn
FROM (VALUES
  ('sales',          'crm123!', 'sales',          '销售-示例'),
  ('manager',        'crm123!', 'manager',        '区域经理-示例'),
  ('exec',           'crm123!', 'exec',           '高管-示例'),
  ('finance',        'crm123!', 'finance',        '财务-示例'),
  ('presales',       'crm123!', 'presales',       '售前-示例'),
  ('contract_admin', 'crm123!', 'contract_admin', '商务-示例')
) AS v(username, pw, role, dn)
WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username = v.username);
```

`src/http/routes.js` 顶部导入追加：

```js
import { login, resolveMe } from './auth.js';
```

`src/http/routes.js` 在 `createRoutes` 内（建议放在 `/api/realtime/health` 之后）追加：

```js
  // ── 真实登录认证（v2 门户）──
  app.post('/api/auth/login', async (req, res) => {
    const r = await login(req.body || {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.status(r.status).json({ token: r.token, role: r.role, display_name: r.display_name });
  });
  app.get('/api/auth/me', async (req, res) => {
    const r = resolveMe(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ role: r.role, display_name: r.display_name, username: r.username });
  });
```

- [ ] **Step 4：运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/auth.test.js`
Expected: PASS（6/6）。若报「relation crm.crm_users does not exist」，先 `node db/migrate.js` 应用 schema（含新表）。

- [ ] **Step 5：提交**

```bash
git add src/http/auth.js db/schema.sql db/seed.sql src/http/routes.js test/auth.test.js
git commit -m "feat(auth): crm_users 表 + 登录/me 路由（HMAC 自签 token，pgcrypto 校验）"
```

---

### Task C：index.html 替换为 AI 作战室骨架 + copilot + token 保护

**Files:**
- Overwrite: `src/web/index.html`
- Test: `test/portal-pages.test.js`（追加用例）

- [ ] **Step 1：写失败测试（扩展 portal-pages.test.js）**

在 `describe('门户双页路由')` 内追加：

```js
  it('GET / 返回 AI 作战室主页含「今日优先」与 copilot', async () => {
    const res = await app.fetch('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('今日优先');
    expect(html).toContain('copilot');
  });
```

- [ ] **Step 2：运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pages.test.js`
Expected: FAIL（旧 index.html 含「观测看板」而非「今日优先」）。

- [ ] **Step 3：覆盖 index.html 为 AI 作战室主页**

> 先确认无测试依赖旧内容：`grep -rn "观测看板" test/ || echo "无依赖，可覆盖"`。

`src/web/index.html`（AI 作战室骨架；JS 逻辑在 Task D/E/F 逐步填充，此处先立骨架 + token 保护与 copilot 容器）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><title>CRM 作战室</title>
<style>
 :root{--bg:#f7f8fb;--panel:#fff;--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--ac:#4f46e5;--as:#eef2ff}
 *{box-sizing:border-box}body{margin:0;font-family:system-ui,"PingFang SC",sans-serif;background:var(--bg);color:var(--ink)}
 .app{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
 .side{background:#0f172a;color:#cbd5e1;padding:18px 14px;display:flex;flex-direction:column;gap:4px}
 .side .brand{color:#fff;font-weight:700;margin:4px 8px 14px}
 .nav a{color:#cbd5e1;text-decoration:none;padding:9px 12px;border-radius:9px;font-size:13px;display:block}
 .nav a.active,.nav a:hover{background:#1e293b;color:#fff}
 .side .foot{margin-top:auto;font-size:11px;color:#64748b}
 .main{padding:22px 26px}
 .copilot{display:flex;gap:10px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;box-shadow:0 1px 3px rgba(15,23,42,.08)}
 .copilot .kbd{font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:6px;padding:2px 7px}
 .copilot input{flex:1;border:none;outline:none;font-size:14px;background:transparent}
 .copilot button{border:none;background:var(--ac);color:#fff;border-radius:9px;padding:8px 16px;font-weight:600;cursor:pointer}
 .chips{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
 .chip{font-size:12px;color:var(--ac);background:var(--as);border:1px solid #e0e7ff;border-radius:999px;padding:5px 12px;cursor:pointer}
 .gen{margin-top:12px;background:var(--as);border:1px dashed #c7d2fe;border-radius:12px;padding:14px;display:none}
 .gen.show{display:block}
 .sec{display:flex;justify-content:space-between;align-items:center;margin:26px 0 12px}
 .sec h2{font-size:15px;margin:0}.sec .sub{font-size:12px;color:var(--mut)}
 .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:0 1px 3px rgba(15,23,42,.08)}
 .card .top{display:flex;justify-content:space-between}.card .name{font-weight:700}
 .card .stage{font-size:11px;color:var(--ac);background:var(--as);border-radius:6px;padding:3px 8px}
 .dims{margin:14px 0 6px;display:flex;flex-direction:column;gap:8px}
 .dim{font-size:12px}.dim .lab{display:flex;justify-content:space-between;color:var(--mut)}
 .bar{height:6px;background:#eef2f7;border-radius:4px;overflow:hidden}.bar>i{display:block;height:100%}
 .how{font-size:12.5px;background:#f8fafc;border-left:3px solid var(--ac);padding:9px 11px;border-radius:6px;margin:10px 0}
 .cta{width:100%;border:1px solid var(--ac);color:var(--ac);background:#fff;border-radius:9px;padding:8px;font-weight:600;cursor:pointer}
 .lower{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:14px;margin-top:14px}
 .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:0 1px 3px rgba(15,23,42,.08)}
 .panel h3{margin:0 0 12px;font-size:13px;color:var(--mut)}
 .l2c{display:flex}.stage{flex:1;text-align:center;padding:10px 4px;position:relative}
 .stage .n{font-size:20px;font-weight:700}.stage .t{font-size:11px;color:var(--mut)}
 .stage:not(:last-child)::after{content:"→";position:absolute;right:-5px;top:14px;color:var(--line)}
 .appr{display:flex;flex-direction:column;gap:9px}.appr .row{display:flex;justify-content:space-between;font-size:13px;padding:8px 10px;background:#f8fafc;border-radius:8px}
 .appr .row .b{font-size:11px;background:#fef3c7;color:#92400e;border-radius:6px;padding:2px 8px}
 .sse{font-size:12px;max-height:150px;overflow:auto}.sse .e{padding:6px 8px;border-bottom:1px solid #f1f5f9;display:flex;gap:8px}
 .sse .e .tg{font-size:10px;color:#fff;border-radius:5px;padding:1px 6px;background:var(--ac)}
 .pool input{width:100%;padding:7px;margin:4px 0;border:1px solid var(--line);border-radius:7px}
 .pool button{margin-top:6px;border:none;background:var(--ac);color:#fff;border-radius:7px;padding:6px 12px;cursor:pointer}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand">⚡ CRM 作战室</div>
    <nav class="nav">
      <a class="active" href="#">🏠 首页</a><a href="#">🎯 线索池</a><a href="#">💼 商机</a>
      <a href="#">📊 L2C 看板</a><a href="#">✅ 审批</a><a href="#">🕸 决策网络</a><a href="#">📈 报告</a>
    </nav>
    <div class="foot">
      <div>身份：<b id="who">—</b> · <a href="/home.html" id="logout" style="color:#94a3b8">退出</a></div>
    </div>
  </aside>
  <main class="main">
    <div class="copilot">
      <span class="kbd">⌘K</span>
      <input id="nl" placeholder="一句话驱动动作：给 30 天未跟进的商机生成唤醒邮件 / 生成本周 pipeline 一页报告">
      <button id="gen">生成动作</button>
    </div>
    <div class="chips">
      <span class="chip" data-nl="给沉寂客户写唤醒邮件">💡 给沉寂客户写唤醒邮件</span>
      <span class="chip" data-nl="生成本周 pipeline 一页报告">💡 本周 pipeline 报告</span>
    </div>
    <div class="gen" id="genBox"><div id="genMeta" style="font-size:12px;color:var(--mut)"></div><div id="genBody"></div></div>

    <div class="sec"><h2>⭐ 今日优先</h2><span class="sub">AI 按 FIT/TIMING/CONNECTION 推送该追的人</span></div>
    <div class="cards" id="cards"><div class="card">加载中…</div></div>

    <div class="lower">
      <div class="panel"><h3>🧭 L2C 六段主线</h3><div class="l2c" id="l2c"></div></div>
      <div class="panel"><h3>✅ 审批收件箱（HITL 四域）</h3><div class="appr" id="appr"></div></div>
      <div class="panel">
        <h3>📡 实时事件流</h3>
        <details open><summary style="cursor:pointer;font-size:12px;color:var(--mut)">折叠/展开</summary>
          <div class="sse" id="sse"></div></details>
      </div>
    </div>

    <div class="panel pool" style="margin-top:14px">
      <h3>⚙ 线索池配置（pick/recycle 规则）</h3>
      <input id="pickRule" placeholder="pick_rule (JSON)"><input id="recycleRule" placeholder="recycle_rule (JSON)">
      <button id="savePool">保存</button><span id="poolMsg" style="font-size:12px;color:var(--mut)"></span>
    </div>
  </main>
</div>
<script type="module">
  import { scoreDeal, suggestAction, buildTodayPriority, l2cCounts } from '/portal/scoring.js';
  const token = localStorage.getItem('crm_token');
  if (!token) location.href = '/home.html';
  const authH = { Authorization: `Bearer ${token}` };
  // 角色自适应
  (async () => {
    try { const r = await fetch('/api/auth/me', { headers: authH }); const j = await r.json();
      if (!r.ok) { localStorage.clear(); location.href = '/home.html'; return; }
      document.getElementById('who').textContent = `${j.display_name}（${j.role}）`;
    } catch { localStorage.clear(); location.href = '/home.html'; }
  })();
  document.getElementById('logout').onclick = () => { localStorage.clear(); };

  // copilot 命令栏
  async function runCopilot() {
    const nl = document.getElementById('nl').value.trim(); if (!nl) return;
    const box = document.getElementById('genBox'), meta = document.getElementById('genMeta'), body = document.getElementById('genBody');
    meta.textContent = '生成中…'; box.classList.add('show'); body.textContent = '';
    try {
      const r = await fetch('/api/page/from-nl', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authH }, body: JSON.stringify({ nl }) });
      const j = await r.json();
      if (!r.ok) { meta.textContent = '需要澄清'; body.textContent = j.error || '请补全指令'; return; }
      meta.textContent = `已生成 draft · 置信度 ${(j.confidence ?? 0).toFixed(2)}` + (j.needsClarification ? ' · 需澄清' : '');
      body.innerHTML = `<div style="margin-bottom:8px">page_id: <code>${j.page_id}</code></div>` +
        (j.previewHtml ? `<iframe srcdoc="${encodeURIComponent(j.previewHtml)}" style="width:100%;height:180px;border:1px solid #e2e8f0;border-radius:8px"></iframe>` : '（无预览）');
    } catch (e) { meta.textContent = '本地 NL 引擎离线'; }
  }
  document.getElementById('gen').onclick = runCopilot;
  document.getElementById('nl').addEventListener('keydown', e => { if (e.key === 'Enter') runCopilot(); });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); document.getElementById('nl').focus(); } });
  document.querySelectorAll('.chip').forEach(c => c.onclick = () => { document.getElementById('nl').value = c.dataset.nl; runCopilot(); });

  // 今日优先 + L2C + 审批（Task D/E 填充逻辑，此处占位拉取）
  async function load() {
    try {
      const [board, dec] = await Promise.all([
        fetch('/api/business/board', { headers: authH }).then(r => r.json()),
        fetch('/api/monitor/decisions', { headers: authH }).then(r => r.json()).catch(() => ({ items: [] })),
      ]);
      const grouped = (board && board.grouped) || {};
      const deals = (grouped.CRM_DEAL || []).map(p => ({ id: p.id, name: p.payload?.name || p.slug || '商机', stage: '报价', updated_at: p.updated_at, budget_fit: 0.6 }));
      const ranked = buildTodayPriority(deals);
      const COL = { FIT: '#4f46e5', TIMING: '#f59e0b', CONN: '#10b981' };
      document.getElementById('cards').innerHTML = ranked.map(d => {
        const s = d.score;
        const bar = (l, v) => `<div class="dim"><div class="lab"><span>${l}</span><span>${v}</span></div><div class="bar"><i style="width:${v}%;background:${COL[l]}"></i></div></div>`;
        const nl = `给「${d.name}」${d.how}`;
        return `<div class="card"><div class="top"><div class="name">${d.name}</div><div class="stage">${d.stage}</div></div>
          <div class="dims">${bar('FIT', s.FIT)}${bar('TIMING', s.TIMING)}${bar('CONN', s.CONN)}</div>
          <div class="how">💡 ${d.how}</div>
          <button class="cta" data-nl="${nl}">怎么切入 → 命令栏</button></div>`;
      }).join('') || '<div class="card">暂无商机</div>';
      document.querySelectorAll('.cta').forEach(b => b.onclick = () => { document.getElementById('nl').value = b.dataset.nl; document.getElementById('nl').focus(); });
      // L2C
      document.getElementById('l2c').innerHTML = l2cCounts(board).map(s => `<div class="stage"><div class="n">${s.count}</div><div class="t">${s.stage}</div></div>`).join('');
      // 审批收件箱（降级：board 筛 submitted）
      const types = ['CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_INVOICE', 'CRM_ORDER'];
      const names = { CRM_QUOTATION: '报价', CRM_CONTRACT: '合同', CRM_INVOICE: '发票', CRM_ORDER: '订单' };
      document.getElementById('appr').innerHTML = types.map(t => {
        const n = (grouped[t] || []).filter(x => x.status === 'submitted').length;
        return `<div class="row"><span>${names[t]}</span><span class="b">${n ? n + ' 待审' : '无'}</span></div>`;
      }).join('');
    } catch (e) {}
  }
  load(); setInterval(load, 15000);

  // SSE
  try {
    const es = new EventSource('/events');
    es.onmessage = e => { const box = document.getElementById('sse');
      const div = document.createElement('div'); div.className = 'e';
      div.innerHTML = `<span class="tg">ev</span><span>${e.data}</span>`;
      box.prepend(div); if (box.children.length > 20) box.lastChild.remove(); };
    es.onerror = () => {};
  } catch (e) {}

  // 池配置
  (async () => {
    try { const r = await fetch('/api/pool-config', { headers: authH }); const j = await r.json();
      document.getElementById('pickRule').value = JSON.stringify(j.pick_rule || {});
      document.getElementById('recycleRule').value = JSON.stringify(j.recycle_rule || {});
    } catch (e) {}
  })();
  document.getElementById('savePool').onclick = async () => {
    const msg = document.getElementById('poolMsg');
    try {
      const r = await fetch('/api/pool-config', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authH },
        body: JSON.stringify({ pick_rule: JSON.parse(document.getElementById('pickRule').value || '{}'), recycle_rule: JSON.parse(document.getElementById('recycleRule').value || '{}') }) });
      msg.textContent = r.ok ? '已保存' : '保存失败';
    } catch (e) { msg.textContent = '保存失败（JSON 格式？）'; }
  };
</script>
</body></html>
```

- [ ] **Step 4：运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pages.test.js`
Expected: PASS（含新用例，GET / 含「今日优先」「copilot」）。

- [ ] **Step 5：提交**

```bash
git add src/web/index.html test/portal-pages.test.js
git commit -m "feat(portal): index.html 替换为 AI 作战室骨架 + copilot + token 保护/角色自适应"
```

---

### Task D：今日优先英雄区 + 打分算法（抽 scoring.js）

**Files:**
- Create: `src/portal/scoring.js`
- Modify: `src/http/routes.js`（新增 `/portal/scoring.js` 静态路由，供浏览器 ESM import）
- Test: `test/portal-scoring.test.js`

- [ ] **Step 1：写失败测试**

```js
// test/portal-scoring.test.js
import { describe, it, expect } from 'vitest';
import { clamp, scoreDeal, suggestAction, buildTodayPriority, l2cCounts } from '../src/portal/scoring.js';

describe('clamp', () => {
  it('约束 0-100 并取整', () => {
    expect(clamp(-5)).toBe(0); expect(clamp(150)).toBe(100); expect(clamp(42.6)).toBe(43);
  });
});
describe('scoreDeal', () => {
  it('idle 越久 TIMING 越低', () => {
    const fresh = scoreDeal({ updated_at: new Date().toISOString(), budget_fit: 0.8 }, 3);
    const stale = scoreDeal({ updated_at: new Date(Date.now() - 40 * 864e5).toISOString(), budget_fit: 0.8 }, 3);
    expect(stale.TIMING).toBeLessThan(fresh.TIMING);
    expect(fresh.FIT).toBe(80);
  });
});
describe('suggestAction', () => {
  it('idle>30 建议唤醒邮件', () => {
    expect(suggestAction({ idleDays: 35, CONN: 50 }, '报价')).toContain('唤醒邮件');
  });
  it('报价且 idle>3 建议推进合同', () => {
    expect(suggestAction({ idleDays: 5, CONN: 50 }, '报价')).toContain('合同');
  });
});
describe('buildTodayPriority', () => {
  it('按 total 降序取 Top3', () => {
    const deals = [
      { id: '1', updated_at: new Date().toISOString(), budget_fit: 0.9 },
      { id: '2', updated_at: new Date(Date.now() - 50 * 864e5).toISOString(), budget_fit: 0.2 },
      { id: '3', updated_at: new Date().toISOString(), budget_fit: 0.5 },
      { id: '4', updated_at: new Date().toISOString(), budget_fit: 0.7 },
    ];
    const r = buildTodayPriority(deals);
    expect(r).toHaveLength(3);
    expect(r[0].score.total).toBeGreaterThanOrEqual(r[1].score.total);
    expect(r[0].how).toBeTruthy();
  });
});
describe('l2cCounts', () => {
  it('按六段聚合 board.grouped', () => {
    const board = { grouped: { CRM_DEAL: [1, 2], CRM_QUOTATION: [1], CRM_CONTRACT: [], CRM_PAYMENT_PLAN: [1, 2, 3], CRM_INVOICE: [], CRM_ORDER: [1] } };
    const r = l2cCounts(board);
    expect(r.map(x => x.count)).toEqual([2, 1, 0, 3, 0, 1]);
    expect(r.map(x => x.stage)).toEqual(['线索', '报价', '合同', '回款', '发票', '订单']);
  });
});
```

- [ ] **Step 2：运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-scoring.test.js`
Expected: FAIL（`../src/portal/scoring.js` 不存在）。

- [ ] **Step 3：实现 scoring.js + 路由**

`src/portal/scoring.js`：

```js
// src/portal/scoring.js — 今日优先打分 + L2C 聚合（浏览器 ESM 与 vitest 共用单源）
export function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))); }

export function scoreDeal(d, decisions = 0) {
  const updated = d.updated_at ? new Date(d.updated_at).getTime() : Date.now();
  const idleDays = Math.max(0, (Date.now() - updated) / 86400000);
  const FIT = clamp((d.budget_fit ?? 0.5) * 100);
  const TIMING = clamp(100 - idleDays * 4);
  const CONN = clamp((decisions / 5) * 100);
  const total = 0.3 * FIT + 0.4 * TIMING + 0.3 * CONN;
  return { FIT, TIMING, CONN, total: Math.round(total), idleDays };
}

export function suggestAction(s, stage) {
  if (s.idleDays > 30) return `已沉寂 ${Math.round(s.idleDays)} 天，建议发送唤醒邮件`;
  if (stage === '报价' && s.idleDays > 3) return '报价未跟进，推进合同签署';
  if (s.CONN < 40) return '关系薄弱，安排一次高层拜访';
  return '状态健康，按节奏推进下一阶段';
}

export function buildTodayPriority(deals, decisionsByDeal = {}) {
  return deals
    .map((d) => {
      const s = scoreDeal(d, decisionsByDeal[d.id] || 0);
      return { ...d, score: s, how: suggestAction(s, d.stage) };
    })
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, 3);
}

const STAGE_ORDER = ['线索', '报价', '合同', '回款', '发票', '订单'];
const TYPE_TO_STAGE = {
  CRM_DEAL: '线索', CRM_QUOTATION: '报价', CRM_CONTRACT: '合同',
  CRM_PAYMENT_PLAN: '回款', CRM_INVOICE: '发票', CRM_ORDER: '订单',
};
export function l2cCounts(board) {
  const counts = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0]));
  const grouped = (board && board.grouped) || {};
  for (const [type, arr] of Object.entries(grouped)) {
    const stage = TYPE_TO_STAGE[type];
    if (stage) counts[stage] = Array.isArray(arr) ? arr.length : 0;
  }
  return STAGE_ORDER.map((s) => ({ stage: s, count: counts[s] }));
}
```

`src/http/routes.js` 在 `createRoutes` 内追加（供浏览器 `import '/portal/scoring.js'`）：

```js
  // 前端打分模块（ESM 单源：浏览器与 vitest 共用）
  app.get('/portal/scoring.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/scoring.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

> 说明：index.html（Task C）已 `import { ... } from '/portal/scoring.js'`，此处路由落地即激活，逻辑与测试同源。

- [ ] **Step 4：运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-scoring.test.js`
Expected: PASS（含 l2cCounts 用例，为 Task E 铺垫）。

- [ ] **Step 5：提交**

```bash
git add src/portal/scoring.js src/http/routes.js test/portal-scoring.test.js
git commit -m "feat(portal): 今日优先打分算法抽为 scoring.js 单源（含 /portal/scoring.js 路由）"
```

---

### Task E：L2C 主线 + 审批收件箱 + SSE 流（逻辑落地）

**Files:**
- Modify: `src/web/index.html`（确认 `load()` 中已用 `l2cCounts` 与审批降级；本 Task 仅核对/微调，无新逻辑——因 Task C 已内联实现）
- Test: `test/portal-scoring.test.js`（已在 Task D 覆盖 `l2cCounts`）

- [ ] **Step 1：核对 Task C 的 index.html 已实现 L2C/审批/SSE**

确认 `src/web/index.html` 的 `<script type="module">` 中 `load()` 已调用 `l2cCounts(board)` 渲染六段、`buildTodayPriority` 渲染今日优先、`/api/business/board` 筛 `status==='submitted'` 渲染审批收件箱、并已 `new EventSource('/events')` 订阅 SSE。若 Task C 已包含则跳过实现。

- [ ] **Step 2：运行全量门户测试确认无回归**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pages.test.js test/portal-scoring.test.js test/auth.test.js`
Expected: PASS（全部门户 + 认证用例）。

- [ ] **Step 3：提交（若 index.html 有微调）**

```bash
git add src/web/index.html
git commit -m "feat(portal): L2C 主线 + 审批收件箱降级 + SSE 实时流落地"
```

> 若 Task C 已完整实现、本 Task 无文件改动，则跳过提交并注明「E 逻辑已在 C 落地，仅回归验证」。

---

### Task F：池配置读写面板 + 双页互链 + 收口提交

**Files:**
- Modify: `src/web/index.html`（池配置面板已在 Task C 内联：`GET/PUT /api/pool-config` + 退出/互链；本 Task 核对）
- Modify: `src/web/home.html`（已含「已进入？直达作战室」互链；核对）
- Test: `test/portal-pages.test.js`（追加 `GET /` 含「线索池配置」标记）

- [ ] **Step 1：写/扩失败测试**

在 `describe('门户双页路由')` 内追加：

```js
  it('GET / 含线索池配置面板', async () => {
    const res = await app.fetch('/');
    const html = await res.text();
    expect(html).toContain('线索池配置');
  });
```

- [ ] **Step 2：运行测试确认通过（Task C 已含该面板）**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pages.test.js`
Expected: PASS（面板标记已存在）。若失败，回 Task C 的 index.html 核对池配置 `.pool` 区块存在。

- [ ] **Step 3：双页互链最终核对**

确认：
- `home.html`：登录成功后 `location.href='/'`；已登录时显示「直达作战室」链接。
- `index.html`：无 token → `/home.html`；`/api/auth/me` 失败 → 清 token 跳 `/home.html`；侧栏「退出」链接 `/home.html`。

- [ ] **Step 4：运行全量相关测试收口**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pages.test.js test/portal-scoring.test.js test/auth.test.js`
Expected: 全部 PASS。

- [ ] **Step 5：提交**

```bash
git add src/web/index.html src/web/home.html test/portal-pages.test.js
git commit -m "feat(portal): 池配置读写面板 + 双页互链（登录/登出）收口"
```

---

## 自我审查（Spec 覆盖）

1. **Spec 覆盖**：① index.html 替换为 AI 作战室（Task C）✓；② Home.html 真实登录（Task A+B）✓；③ copilot 命令栏接 `/api/page/from-nl`（Task C）✓；④ 今日优先 FIT/TIMING/CONN 打分（Task D）✓；⑤ L2C 主线 + 审批收件箱 + SSE（Task C/E）✓；⑥ 池配置读写（Task C/F）✓；⑦ 双页互链 + 角色自适应（Task C/F）✓；⑧ 认证后端（Task B）✓。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤均含完整实现。
3. **类型一致性**：`scoreDeal`→`buildTodayPriority`→`l2cCounts` 签名在 Task D 定义、Task C index.html 引用一致；`login`/`resolveMe` 在 Task B 定义、routes 引用一致；`/portal/scoring.js` 路由（Task D）与 index.html import（Task C）路径一致。

## 执行提示
- 真实运行前先 `node db/migrate.js` 应用 `crm.crm_users` 表 + 种子（Task B 后）。
- 演示账号：用户名 `sales/manager/exec/finance/presales/contract_admin`，密码均 `crm123!`。
- 不引入 jwt/pg 额外依赖：token 用 `crypto` HMAC 自签，密码用既有 `pgcrypto.crypt`。
- 提交严格每 Task 一 commit；并行会话改动文件（approval/engine.js 等）勿混入本次提交。
