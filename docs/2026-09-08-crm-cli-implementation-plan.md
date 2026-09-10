# crm-native-cli Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `crm-native-cli`——一个本地 CLI 连接器，以「本地进程 + 本地鉴权 + 三档端点」直连 CRM MCP 通道，绕开 `chiyuai.com` 未备案导致的 SNI 拦截，为 Buddy 应用连接器上架打通路径。

**Architecture:** CLI 子命令把请求组装成 JSON-RPC 2.0，POST 到 StreamableHTTP `/mcp`（`initialize` → 取 `Mcp-Session-Id` → `notifications/initialized` → `tools/list` / `tools/call`）。网络层用 nginx Basic Auth，应用层用 `crm_login` 换取 `api_token` 后以 `params.api_token` 透传（两者共存时必须走 params，因单个 `Authorization` 头无法同时携带）。写类工具名在**发请求之前**被黑名单前置拒绝。

**Tech Stack:** Node ≥22.20（内置 `fetch`，**零运行时依赖**）、ESM、vitest 3（测试）、PowerShell（命令示例）。

**设计来源：** `docs/2026-09-08-crm-cli-connector-design.md`（已批准）。计划存放路径沿用本项目惯例（`docs/` 根目录），非 SKILL 默认的 `docs/superpowers/plans/`。

**任务映射（设计 → 计划）：** T1→Task1；T2→Task2+3；T3→Task4+5+6；T4→Task7；T5→Task8+9。

---

## 文件结构

```
packages/crm-native-cli/
├── package.json              # name=crm-native-cli, bin={crm-cli}, type=module, engines.node>=22.20.0
├── README.md                 # 安装/鉴权/端点切换/只读红线说明
├── src/
│   ├── cli.js                # 命令分发（use/auth/call/deal/account/version）
│   ├── endpoints.js          # 三档端点单一事实源 + 默认 prod + www 诊断口径
│   ├── credentials.js        # ~/.crm-cli/credentials 读写（0600）
│   ├── mcpClient.js          # JSON-RPC + 会话 + JSON/SSE 双解析
│   ├── guard.js              # 写类工具名黑名单，前置拒绝
│   └── commands/
│       ├── use.js            # 切换端点档位
│       ├── auth.js           # auth login / auth status
│       ├── call.js           # 通用转发
│       ├── deal.js           # deal list（语义化只读 ①）
│       └── account.js        # account show（语义化只读 ②）
└── test/
    ├── endpoints.test.js
    ├── credentials.test.js
    ├── guard.test.js
    └── mcpClient.test.js

connector/
├── cli.json                  # 新增：CLI 连接器契约（对齐北森）
└── skills/crm-cli/
    ├── SKILL.md              # requires-cli + 只读红线
    └── references/endpoints.md
```

> 既有 `connector/connector-meta.json`（v1.5.0 MCP 通道）与 `connector/mcp.json` **一律保留，不删除**。

---

## Task 1: 包骨架与 connector/cli.json

**Files:**
- Create: `packages/crm-native-cli/package.json`
- Create: `packages/crm-native-cli/src/cli.js`
- Create: `connector/cli.json`

- [ ] **Step 1: 写失败测试**

创建 `packages/crm-native-cli/test/cli.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('包骨架', () => {
  it('package.json 声明 bin=crm-cli 且 engines.node>=22.20.0', () => {
    const p = JSON.parse(readFileSync(join(root, 'packages/crm-native-cli/package.json'), 'utf8'));
    expect(p.name).toBe('crm-native-cli');
    expect(p.bin['crm-cli']).toBe('src/cli.js');
    expect(p.type).toBe('module');
    expect(p.engines.node).toBe('>=22.20.0');
  });

  it('connector/cli.json 五段齐备且 statusMatchJson 为 valid', () => {
    const c = JSON.parse(readFileSync(join(root, 'connector/cli.json'), 'utf8'));
    for (const k of ['init', 'auth', 'unAuth', 'status', 'versionCheck']) {
      expect(c[k], `缺字段 ${k}`).toBeTruthy();
    }
    expect(c.statusMatchJson).toEqual({ status: 'valid' });
    expect(c.init.win32).toContain('npm install -g crm-native-cli');
    expect(c.status.win32).toBe('crm-cli auth status');
  });

  it('既有 MCP 通道文件未被删除', () => {
    expect(existsSync(join(root, 'connector/connector-meta.json'))).toBe(true);
    expect(existsSync(join(root, 'connector/mcp.json'))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
cd D:\system\CRM-ai-native; npx vitest run packages/crm-native-cli/test/cli.test.js
```

Expected: FAIL（文件不存在）。

- [ ] **Step 3: 写 package.json**

```json
{
  "name": "crm-native-cli",
  "version": "1.0.0",
  "description": "CRM-ai-native 本地 CLI 连接器：只读直连 CRM MCP 通道（生产/本机/域名三档端点）",
  "type": "module",
  "bin": { "crm-cli": "src/cli.js" },
  "files": ["src", "README.md"],
  "engines": { "node": ">=22.20.0" },
  "scripts": { "test": "vitest run" },
  "license": "MIT"
}
```

- [ ] **Step 4: 写最小 cli.js（仅分发 + version + 未实现命令报错）**

```js
#!/usr/bin/env node
// src/cli.js — crm-native-cli 入口（第一版：use/auth/call/deal/account/version）
const [cmd, ...rest] = process.argv.slice(2);

const USAGE = `crm-native-cli 1.0.0
用法:
  crm-cli use <prod|local|www>      切换端点档位（默认 prod）
  crm-cli auth login|status         鉴权（终端交互录入，不落聊天）
  crm-cli call <tool> [json]        透传 MCP 只读工具
  crm-cli deal list [--stage S1]    商机列表（只读）
  crm-cli account show <名称>       客户 360（只读）
  crm-cli version                   版本号`;

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(USAGE);
  process.exit(0);
}
if (cmd === 'version') {
  console.log('1.0.0');
  process.exit(0);
}
console.error(`未实现的命令: ${cmd}\n${USAGE}`);
process.exit(2);
```

- [ ] **Step 5: 写 connector/cli.json**

```json
{
  "init": {
    "win32": "npm install -g crm-native-cli",
    "darwin": "npm install -g crm-native-cli",
    "linux": "npm install -g crm-native-cli"
  },
  "auth":   { "win32": "crm-cli auth login",  "darwin": "crm-cli auth login",  "linux": "crm-cli auth login" },
  "unAuth": { "win32": "crm-cli auth logout", "darwin": "crm-cli auth logout", "linux": "crm-cli auth logout" },
  "status": { "win32": "crm-cli auth status", "darwin": "crm-cli auth status", "linux": "crm-cli auth status" },
  "statusMatchJson": { "status": "valid" },
  "versionCheck": {
    "command": { "win32": "crm-cli version", "darwin": "crm-cli version", "linux": "crm-cli version" },
    "minVersion": "1.0.0",
    "versionPattern": "(\\d+\\.\\d+\\.\\d+)"
  },
  "runtime": { "type": "node", "version": ">=22.20.0" }
}
```

- [ ] **Step 6: 运行测试确认通过**

```powershell
cd D:\system\CRM-ai-native; npx vitest run packages/crm-native-cli/test/cli.test.js
```

Expected: PASS（3 passed）。

- [ ] **Step 7: Commit**

```powershell
git add packages/crm-native-cli/package.json packages/crm-native-cli/src/cli.js connector/cli.json packages/crm-native-cli/test/cli.test.js
git commit -m "feat(crm-cli): 包骨架与 connector/cli.json（对齐北森 CLI 连接器契约）"
```

---

## Task 2: 三档端点（prod / local / www）

**Files:**
- Create: `packages/crm-native-cli/src/endpoints.js`
- Create: `packages/crm-native-cli/test/endpoints.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import { ENDPOINTS, DEFAULT_ENDPOINT, resolveEndpoint, diagnoseUnreachable } from '../src/endpoints.js';

describe('端点档位', () => {
  it('三档齐备且默认 prod', () => {
    expect(Object.keys(ENDPOINTS).sort()).toEqual(['local', 'prod', 'www']);
    expect(DEFAULT_ENDPOINT).toBe('prod');
  });

  it('prod/local 为 http，www 为 https', () => {
    expect(ENDPOINTS.prod.url).toBe('http://81.70.184.198/mcp');
    expect(ENDPOINTS.local.url).toBe('http://localhost:3001/mcp');
    expect(ENDPOINTS.www.url).toBe('https://www.chiyuai.com/mcp');
  });

  it('未知档位抛错并列出可选值', () => {
    expect(() => resolveEndpoint('staging')).toThrow(/未知端点档位: staging/);
    expect(() => resolveEndpoint('staging')).toThrow(/prod \| local \| www/);
  });

  it('www 不可达时给出 SNI/备案诊断，且不明示降级', () => {
    const msg = diagnoseUnreachable('www', new Error('connect ECONNREFUSED'));
    expect(msg).toMatch(/SNI|备案/);
    expect(msg).not.toMatch(/已切换|已降级/);
  });
});
```

- [ ] **Step 2: 运行确认失败**（`npx vitest run packages/crm-native-cli/test/endpoints.test.js`，Expected: FAIL 模块不存在）

- [ ] **Step 3: 实现 endpoints.js**

```js
// src/endpoints.js — 三档端点单一事实源
// ⚠ prod 必须 http：nginx /mcp 为 http 直连，改 https 会因证书不匹配丢失 Authorization 头。
export const ENDPOINTS = Object.freeze({
  prod:  { id: 'prod',  url: 'http://81.70.184.198/mcp',   note: '生产（IP 直连免备案；必须 http）', reachable: true },
  local: { id: 'local', url: 'http://localhost:3001/mcp',  note: '本机联调',                        reachable: true },
  www:   { id: 'www',   url: 'https://www.chiyuai.com/mcp', note: '备案解除后的目标形态；当前 SNI 级拦截', reachable: false },
});

export const DEFAULT_ENDPOINT = 'prod';

export function resolveEndpoint(id = DEFAULT_ENDPOINT) {
  const ep = ENDPOINTS[id];
  if (!ep) throw new Error(`未知端点档位: ${id}（可选: ${Object.keys(ENDPOINTS).join(' | ')}）`);
  return ep;
}

// 失败诊断：必须明确原因，禁止静默重试或降级到其他档位（降级会让用户误判通道已通）
export function diagnoseUnreachable(id, err) {
  const ep = ENDPOINTS[id];
  const reason = err?.message || String(err);
  if (id === 'www') {
    return `端点 ${id} (${ep.url}) 不可达：疑似 SNI 级拦截 / 未 ICP 备案（原始错误: ${reason}）。` +
           `该档位在备案解除前不可用；请改用 crm-cli use prod 或 crm-cli use local。本次未做任何自动切换。`;
  }
  return `端点 ${id} (${ep.url}) 不可达：${reason}。请确认服务已启动、URL 与 Basic Auth 配置正确。`;
}
```

- [ ] **Step 4: 运行确认通过**（Expected: PASS 4 passed）

- [ ] **Step 5: Commit**

```powershell
git add packages/crm-native-cli/src/endpoints.js packages/crm-native-cli/test/endpoints.test.js
git commit -m "feat(crm-cli): 三档端点(prod/local/www)与不可达诊断口径"
```

---

## Task 3: 凭据存储与 auth 子命令

**Files:**
- Create: `packages/crm-native-cli/src/credentials.js`
- Create: `packages/crm-native-cli/src/commands/auth.js`
- Create: `packages/crm-native-cli/test/credentials.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 用临时 HOME 隔离，绝不污染真实 ~/.crm-cli
const tmp = mkdtempSync(join(tmpdir(), 'crmcli-'));
process.env.CRM_CLI_HOME = tmp;

const { CRED_PATH, saveCredentials, loadCredentials, clearCredentials } = await import('../src/credentials.js');

describe('凭据存储', () => {
  afterEach(() => { if (existsSync(CRED_PATH)) rmSync(CRED_PATH, { force: true }); });

  it('保存后可读回，且文件权限为 0600（Windows 下尽力而为）', () => {
    saveCredentials({ endpoint: 'prod', user: 'admin', pass: 'x', apiToken: 't', expiresAt: Date.now() + 1000 });
    const c = loadCredentials();
    expect(c.user).toBe('admin');
    expect(c.apiToken).toBe('t');
    if (process.platform !== 'win32') {
      expect(statSync(CRED_PATH).mode & 0o777).toBe(0o600);
    }
  });

  it('未登录时返回 null，不抛错', () => {
    if (existsSync(CRED_PATH)) rmSync(CRED_PATH, { force: true });
    expect(loadCredentials()).toBeNull();
  });

  it('序列化内容不含多余字段（不落聊天、不落口令明文以外的东西）', () => {
    saveCredentials({ endpoint: 'prod', user: 'admin', pass: 'x' });
    const raw = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
    expect(Object.keys(raw).sort()).toEqual(['endpoint', 'pass', 'user']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 credentials.js**

```js
// src/credentials.js — 凭据仅落本地，绝不进仓库/日志/聊天
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.CRM_CLI_HOME || homedir();
export const CRED_PATH = join(HOME, '.crm-cli', 'credentials');

export function saveCredentials(obj) {
  mkdirSync(dirname(CRED_PATH), { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(CRED_PATH, 0o600); } catch { /* Windows 无 POSIX 权限，尽力而为 */ }
  return CRED_PATH;
}

export function loadCredentials() {
  if (!existsSync(CRED_PATH)) return null;
  try { return JSON.parse(readFileSync(CRED_PATH, 'utf8')); } catch { return null; }
}

export function clearCredentials() {
  if (existsSync(CRED_PATH)) rmSync(CRED_PATH, { force: true });
}
```

- [ ] **Step 4: 实现 commands/auth.js（login 交互录入 + status 探活）**

```js
// src/commands/auth.js — auth login / auth status
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { saveCredentials, loadCredentials } from '../credentials.js';
import { resolveEndpoint, diagnoseUnreachable, DEFAULT_ENDPOINT } from '../endpoints.js';
import { mcpCall } from '../mcpClient.js';

// ⚠ 零信任：口令只在终端交互读取，绝不回显、绝不写入日志、绝不经聊天传递
async function promptSecret(rl, label) {
  output.write(`${label}: `);
  return new Promise((resolve) => {
    const wasRaw = input.isRaw || false;
    if (input.setRawMode) input.setRawMode(true);
    let v = '';
    const onData = (ch) => {
      const s = String(ch);
      if (s === '\n' || s === '\r' || s === '\u0004') {
        input.off('data', onData);
        if (input.setRawMode) input.setRawMode(wasRaw);
        output.write('\n');
        resolve(v);
      } else if (s === '\u007f') { v = v.slice(0, -1); }
      else { v += s; }
    };
    input.on('data', onData);
  });
}

export async function authLogin(args = {}) {
  const id = args.endpoint || DEFAULT_ENDPOINT;
  const ep = resolveEndpoint(id);
  const rl = createInterface({ input, output });
  try {
    const user = (await rl.question(`CRM 用户名 (端点 ${id} ${ep.url}): `)).trim();
    const pass = await promptSecret(rl, 'CRM 密码（不回显）');
    if (!user || !pass) { console.error('用户名与密码均不能为空'); process.exit(2); }

    // 应用层鉴权：调用 crm_login 换取 api_token（MCP requireAuth=true）
    const res = await mcpCall({
      endpointId: id, basic: { user, pass }, tool: 'crm_login',
      params: { username: user, password: pass },
    });
    const token = res?.api_token || res?.token;
    if (!token) { console.error('crm_login 未返回 api_token'); process.exit(1); }

    saveCredentials({
      endpoint: id, user, pass,
      apiToken: token,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000, // 与 MCP tokenTtlMs 8h 对齐
    });
    console.log(`已登录：端点 ${id}（${ep.url}），凭据存于 ~/.crm-cli/credentials`);
  } catch (e) {
    console.error(diagnoseUnreachable(id, e));
    process.exit(1);
  } finally { rl.close(); }
}

export async function authStatus() {
  const c = loadCredentials();
  if (!c?.apiToken || (c.expiresAt && c.expiresAt < Date.now())) {
    console.log(JSON.stringify({ status: 'invalid', reason: c ? 'token 已过期，请重新 auth login' : '未登录' }));
    process.exit(1);
  }
  try {
    // 探活统一走 tools/list：注册表内无 crm_ping 工具
    await mcpCall({ endpointId: c.endpoint, basic: { user: c.user, pass: c.pass }, token: c.apiToken, listTools: true });
    console.log(JSON.stringify({ status: 'valid', endpoint: c.endpoint }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'invalid', reason: e.message }));
    process.exit(1);
  }
}
```

- [ ] **Step 5: 运行确认通过**

- [ ] **Step 6: Commit**

```powershell
git add packages/crm-native-cli/src/credentials.js packages/crm-native-cli/src/commands/auth.js packages/crm-native-cli/test/credentials.test.js
git commit -m "feat(crm-cli): 凭据本地存储(0600)与 auth login/status"
```

---

## Task 4: MCP 客户端（JSON-RPC + 会话 + JSON/SSE 解析）

**Files:**
- Create: `packages/crm-native-cli/src/mcpClient.js`
- Create: `packages/crm-native-cli/test/mcpClient.test.js`

- [ ] **Step 1: 写失败测试（用桩 fetch，不发真实请求）**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mcpCall, parseRpcBody, __setFetch } from '../src/mcpClient.js';

describe('MCP 客户端', () => {
  beforeEach(() => { __setFetch(null); });

  it('initialize 后携带 Mcp-Session-Id，并发送 notifications/initialized', async () => {
    const calls = [];
    __setFetch(async (url, opt) => {
      const body = JSON.parse(opt.body);
      calls.push({ url, method: body.method, headers: opt.headers });
      const isInit = body.method === 'initialize';
      return {
        ok: true, status: 200,
        headers: { get: (k) => (isInit && k.toLowerCase() === 'mcp-session-id' ? 'sess-1' : 'application/json') },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }),
      };
    });
    await mcpCall({ endpointId: 'prod', basic: { user: 'a', pass: 'b' }, tool: 'crm-account-360', params: { name: 'XX 制造' } });
    expect(calls[0].method).toBe('initialize');
    expect(calls.some((c) => c.method === 'notifications/initialized')).toBe(true);
    expect(calls.at(-1).method).toBe('tools/call');
    expect(calls.at(-1).headers['Mcp-Session-Id']).toBe('sess-1');
  });

  it('Basic 与 api_token 共存：Authorization 为 Basic，token 走 params', async () => {
    let last;
    __setFetch(async (url, opt) => {
      last = { headers: opt.headers, body: JSON.parse(opt.body) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) };
    });
    await mcpCall({ endpointId: 'prod', basic: { user: 'admin', pass: 'p' }, token: 'T', tool: 'x', params: { q: 1 } });
    expect(last.headers.Authorization).toMatch(/^Basic /);
    const call = last.body;
    expect(call.params.api_token).toBe('T');
  });

  it('SSE 与 JSON 两种响应都能解析', () => {
    expect(parseRpcBody('application/json', '{"jsonrpc":"2.0","id":1,"result":{"a":1}}')).toEqual({ a: 1 });
    expect(parseRpcBody('text/event-stream', 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":2}}\n\n')).toEqual({ a: 2 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 mcpClient.js**

```js
// src/mcpClient.js — StreamableHTTP JSON-RPC 客户端（零依赖）
import { resolveEndpoint, diagnoseUnreachable } from './endpoints.js';

let injectedFetch = null;
export const __setFetch = (f) => { injectedFetch = f; };
const doFetch = (...a) => (injectedFetch || fetch)(...a);

const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

export function parseRpcBody(contentType, text) {
  if (String(contentType).includes('text/event-stream')) {
    const line = text.split('\n').map((s) => s.trim()).find((s) => s.startsWith('data:'));
    const payload = line ? line.slice(5).trim() : text;
    return JSON.parse(payload).result;
  }
  return JSON.parse(text).result;
}

async function rpc({ ep, basic, token, sessionId, method, params, id }) {
  const headers = { ...BASE_HEADERS };
  // 网络层：nginx Basic Auth（生产档必须 http，否则证书不匹配会丢 Authorization）
  if (basic) headers.Authorization = `Basic ${Buffer.from(`${basic.user}:${basic.pass}`).toString('base64')}`;
  else if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await doFetch(ep.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const nextSession = res.headers?.get?.('mcp-session-id') || sessionId;
  return { result: parseRpcBody(res.headers?.get?.('content-type') || 'application/json', text), nextSession };
}

export async function mcpCall({ endpointId, basic, token, tool, params = {}, listTools = false }) {
  const ep = resolveEndpoint(endpointId);
  let sessionId;
  try {
    const init = await rpc({ ep, basic, token, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'crm-native-cli', version: '1.0.0' },
    }, id: 1 });
    sessionId = init.nextSession;
    await rpc({ ep, basic, token, sessionId, method: 'notifications/initialized', params: {}, id: 2 });
    if (listTools) {
      const r = await rpc({ ep, basic, token, sessionId, method: 'tools/list', params: {}, id: 3 });
      return r.result;
    }
    // 应用层鉴权：token 走 params.api_token（与 Basic 头共存；extractToken 中 params 优先）
    const merged = token ? { ...params, api_token: token } : params;
    const r = await rpc({ ep, basic, token, sessionId, method: 'tools/call', params: { name: tool, arguments: merged }, id: 4 });
    return r.result?.content?.[0]?.text ? JSON.parse(r.result.content[0].text) : r.result;
  } catch (e) {
    throw Object.assign(new Error(diagnoseUnreachable(endpointId, e)), { cause: e });
  }
}
```

> 注：`authStatus` 的探活统一走 `mcpCall({ listTools: true })`（`tools/list`），不使用 `crm_ping`——注册表无该工具。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit**

```powershell
git add packages/crm-native-cli/src/mcpClient.js packages/crm-native-cli/test/mcpClient.test.js
git commit -m "feat(crm-cli): MCP StreamableHTTP 客户端(会话+JSON/SSE 双解析)"
```

---

## Task 5: 写操作前置拦截（红线）

**Files:**
- Create: `packages/crm-native-cli/src/guard.js`
- Create: `packages/crm-native-cli/test/guard.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, vi } from 'vitest';
import { assertReadOnly, WRITE_TOOLS } from '../src/guard.js';
import { mcpCall, __setFetch } from '../src/mcpClient.js';

describe('写操作红线', () => {
  it('写类工具名被识别', () => {
    for (const t of ['crm-deal-advance', 'data-particle-create', 'crm-asset-attach', 'crm-approval-approve', 'payment-budget-prehold', 'split']) {
      expect(WRITE_TOOLS.has(t)).toBe(true);
    }
  });

  it('只读工具放行', () => {
    expect(() => assertReadOnly('crm-account-360')).not.toThrow();
    expect(() => assertReadOnly('crm-funnel-classify')).not.toThrow();
  });

  it('写类工具抛错且提示 HITL 与 decision_id', () => {
    expect(() => assertReadOnly('crm-deal-advance')).toThrow(/HITL/);
    expect(() => assertReadOnly('crm-deal-advance')).toThrow(/decision_id/);
  });

  it('拦截发生在发请求之前（fetch 零调用）', async () => {
    let n = 0;
    __setFetch(async () => { n += 1; return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' }; });
    await expect((async () => { assertReadOnly('crm-deal-advance'); await mcpCall({ endpointId: 'prod', tool: 'crm-deal-advance', params: {} }); })()).rejects.toThrow(/HITL/);
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 guard.js**

```js
// src/guard.js — 写操作红线：判定顺序即安全边界，必须排在任何转发/降级之前
// 真实写类工具名取自 src/action/seed-actions.js（kind: 'write'），另含 P2P 付费域动词以防跨系统误调
export const WRITE_TOOLS = new Set([
  'crm-deal-advance', 'crm-deal-reopen',
  'crm-asset-attach', 'crm-knowledge-upsert', 'crm-memory-upsert',
  'data-particle-create', 'data-particle-update', 'data-particle-edge-create',
  'crm-approval-start', 'crm-approval-approve', 'crm-approval-add-sign', 'crm-approval-transfer',
  'crm-review-gate-approve',
  'submit', 'approve', 'pay', 'split', 'reject', 'withdraw',
  'payment-budget-prehold', 'payment-budget-release', 'payment-hold',
  'crm-login',
]);

// 前缀匹配：payment_* / write_* 一类
const WRITE_PREFIXES = ['payment-', 'payment_', 'write-', 'delete-', 'remove-'];

export function isWriteTool(name) {
  const n = String(name || '').toLowerCase();
  return WRITE_TOOLS.has(n) || WRITE_PREFIXES.some((p) => n.startsWith(p));
}

export function assertReadOnly(tool) {
  if (isWriteTool(tool)) {
    throw new Error(
      `拒绝执行写类工具 "${tool}"：crm-native-cli 第一版仅支持只读。` +
      `写操作须经 HITL 显式确认、携带 decision_id，并走 CRM_APPROVAL_FLOW；` +
      `线下/绕过系统的写入会形成治理缺口，请改用平台页面或已授权的写入通道。`
    );
  }
  return true;
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: Commit**

```powershell
git add packages/crm-native-cli/src/guard.js packages/crm-native-cli/test/guard.test.js
git commit -m "feat(crm-cli): 写类工具前置拦截(零网络请求)"
```

---

## Task 6: call 命令（通用转发）

**Files:**
- Create: `packages/crm-native-cli/src/commands/call.js`
- Modify: `packages/crm-native-cli/src/cli.js`

- [ ] **Step 1: 实现 call.js**

```js
// src/commands/call.js — 通用转发（只读）
import { mcpCall } from '../mcpClient.js';
import { assertReadOnly } from '../guard.js';
import { loadCredentials } from '../credentials.js';
import { DEFAULT_ENDPOINT } from '../endpoints.js';

export async function callTool(args) {
  const [tool, jsonRaw] = args;
  if (!tool) { console.error('用法: crm-cli call <tool> [json]'); process.exit(2); }
  let params = {};
  if (jsonRaw) { try { params = JSON.parse(jsonRaw); } catch { console.error('参数 JSON 解析失败'); process.exit(2); } }
  assertReadOnly(tool); // 红线：在任何网络请求之前
  const c = loadCredentials();
  if (!c) { console.error('未登录：请先 crm-cli auth login'); process.exit(1); }
  const out = await mcpCall({ endpointId: c.endpoint || DEFAULT_ENDPOINT, basic: { user: c.user, pass: c.pass }, token: c.apiToken, tool, params });
  console.log(JSON.stringify(out, null, 2));
}
```

- [ ] **Step 2: 在 cli.js 中接线**

在 `if (cmd === 'version')` 之后插入：

```js
const dispatch = {
  use:  () => import('./commands/use.js').then((m) => m.useEndpoint(rest)),
  auth: () => import('./commands/auth.js').then((m) => (rest[0] === 'login' ? m.authLogin() : m.authStatus())),
  call: () => import('./commands/call.js').then((m) => m.callTool(rest)),
  deal: () => import('./commands/deal.js').then((m) => m.dealList(rest)),
  account: () => import('./commands/account.js').then((m) => m.accountShow(rest)),
};
if (dispatch[cmd]) {
  dispatch[cmd]().catch((e) => { console.error(e.message); process.exit(1); });
} else {
  console.error(`未知命令: ${cmd}\n${USAGE}`);
  process.exit(2);
}
```

- [ ] **Step 3: 运行全量测试**

```powershell
cd D:\system\CRM-ai-native; npx vitest run packages/crm-native-cli
```

Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```powershell
git add packages/crm-native-cli/src/commands/call.js packages/crm-native-cli/src/cli.js
git commit -m "feat(crm-cli): call 通用转发并接线到入口"
```

---

## Task 7: 两条语义化只读命令（deal list / account show）

**Files:**
- Create: `packages/crm-native-cli/src/commands/deal.js`
- Create: `packages/crm-native-cli/src/commands/account.js`
- Create: `packages/crm-native-cli/src/commands/use.js`

- [ ] **Step 1: 实现 use.js**

```js
// src/commands/use.js
import { saveCredentials, loadCredentials } from '../credentials.js';
import { resolveEndpoint } from '../endpoints.js';
export async function useEndpoint(args) {
  const id = args[0];
  if (!id) { console.error('用法: crm-cli use <prod|local|www>'); process.exit(2); }
  const ep = resolveEndpoint(id);      // 未知档位直接抛错
  const c = loadCredentials() || {};
  saveCredentials({ ...c, endpoint: id });
  console.log(`当前端点: ${id} → ${ep.url}\n${ep.note}`);
}
```

- [ ] **Step 2: 实现 deal.js / account.js**

```js
// src/commands/deal.js — 语义化只读 ①
import { mcpCall } from '../mcpClient.js';
import { assertReadOnly } from '../guard.js';
import { loadCredentials } from '../credentials.js';
import { DEFAULT_ENDPOINT } from '../endpoints.js';

export async function dealList(args) {
  const stageIdx = args.indexOf('--stage');
  const params = stageIdx !== -1 ? { stage: args[stageIdx + 1] } : {};
  assertReadOnly('crm-funnel-classify');
  const c = loadCredentials();
  if (!c) { console.error('未登录：请先 crm-cli auth login'); process.exit(1); }
  // 真实只读工具：crm-funnel-classify（按阶段分布），无独立的 crm-deal-list 工具
  const out = await mcpCall({ endpointId: c.endpoint || DEFAULT_ENDPOINT, basic: { user: c.user, pass: c.pass }, token: c.apiToken, tool: 'crm-funnel-classify', params });
  // 字段映射以真实返回为准：首次联调时用 crm-cli call crm-funnel-classify '{}' 核对后固化
  const rows = Array.isArray(out) ? out : (out?.items || out?.rows || out?.deals || []);
  if (rows.length === 0) { console.error('返回空集合：请确认端点、租户与筛选条件（空集合不等于成功）'); process.exit(1); }
  console.log(['商机号', '阶段', '金额', '客户'].join('\t'));
  for (const r of rows) console.log([r.code || r.id, r.stage, r.amount, r.account_name || r.account].join('\t'));
}
```

```js
// src/commands/account.js — 语义化只读 ②
import { mcpCall } from '../mcpClient.js';
import { assertReadOnly } from '../guard.js';
import { loadCredentials } from '../credentials.js';
import { DEFAULT_ENDPOINT } from '../endpoints.js';

export async function accountShow(args) {
  const name = args[0];
  if (!name) { console.error('用法: crm-cli account show <客户名称>'); process.exit(2); }
  assertReadOnly('crm-account-360');
  const c = loadCredentials();
  if (!c) { console.error('未登录：请先 crm-cli auth login'); process.exit(1); }
  const out = await mcpCall({ endpointId: c.endpoint || DEFAULT_ENDPOINT, basic: { user: c.user, pass: c.pass }, token: c.apiToken, tool: 'crm-account-360', params: { name } });
  console.log(`客户：${out?.name || name}`);
  console.log('关键联系人：', (out?.contacts || []).map((x) => x.name).join('、') || '（无）');
  console.log('在跟商机：', (out?.deals || []).map((d) => `${d.code}/${d.stage}`).join('、') || '（无）');
}
```

- [ ] **Step 3: 运行全量测试**

- [ ] **Step 4: Commit**

```powershell
git add packages/crm-native-cli/src/commands/use.js packages/crm-native-cli/src/commands/deal.js packages/crm-native-cli/src/commands/account.js
git commit -m "feat(crm-cli): use/deal list/account show 三条命令"
```

---

## Task 8: 连接器技能包

**Files:**
- Create: `connector/skills/crm-cli/SKILL.md`
- Create: `connector/skills/crm-cli/references/endpoints.md`

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: crm-cli
description: 通过本地 CLI 只读查询 CRM——商机列表、客户 360、任意只读 MCP 工具透传。触发词：查商机、客户 360、CRM 查询、这家客户什么情况、本周要跟进哪些商机。
version: 1.0.0
category: crm
author: ChiYu 青羽
requires-cli: crm-native-cli
allowed-tools: Bash(crm-cli:*)
---

# crm-cli

## CRITICAL — 只读红线

本技能**仅只读**。任何写操作（推进阶段、提交审批、付款、分账、挂接附件）**一律不得通过本技能执行**：
调用前必须经 `crm-cli` 的写类工具拦截；若用户要求写入，回复「写操作需经 HITL 显式确认 + decision_id + CRM_APPROVAL_FLOW，请走平台页面或已授权写入通道」。

## 端点

| 档位 | URL | 说明 |
|---|---|---|
| prod（默认） | http://81.70.184.198/mcp | 生产；必须 http |
| local | http://localhost:3001/mcp | 本机联调 |
| www | https://www.chiyuai.com/mcp | 备案解除前不可用（SNI 拦截） |

切换：`crm-cli use <prod|local|www>`。不可达时必须原样转述诊断信息，**不得自行改档位**。

## 常用命令

- `crm-cli auth status` → `{"status":"valid"}` 方可继续；否则提示用户 `crm-cli auth login`
- `crm-cli deal list --stage S1`
- `crm-cli account show "XX 制造"`
- `crm-cli call <tool> '<json>'`（仅只读工具）

## 报价/折扣场景常驻提醒

凡涉及报价、折扣、价格的回复，末尾**必须**附加：
「报价须走 CRM_APPROVAL_FLOW 并携带 decision_id；线下私下报价会形成治理缺口。」
```

- [ ] **Step 2: 写 references/endpoints.md**（三档端点、http 约束、SNI 诊断口径、Basic+api_token 共存说明）

- [ ] **Step 3: Commit**

```powershell
git add connector/skills/crm-cli
git commit -m "feat(crm-cli): 连接器技能包(只读红线+三档端点说明)"
```

---

## Task 9: 端到端验证

**Files:** 无新增（验证任务）

- [ ] **Step 1: 本地安装与鉴权**

```powershell
cd D:\system\CRM-ai-native\packages\crm-native-cli; npm link
crm-cli use prod
crm-cli auth login      # 终端交互录入，不落聊天
crm-cli auth status
```

Expected: `{"status":"valid","endpoint":"prod"}`

- [ ] **Step 2: 通道验证（真实数据）**

```powershell
crm-cli call crm-funnel-classify '{"stage":"S1"}'
crm-cli deal list --stage S1
crm-cli account show "XX 制造"
```

Expected: 非空表格；空集合按设计判失败（Task 7 已内置）。

- [ ] **Step 3: 红线验证**

```powershell
crm-cli call crm-deal-advance '{}'
```

Expected: 拒绝 + HITL/decision_id 提示，且**无任何网络请求**（Task 5 已断言）。

- [ ] **Step 4: www 档诊断验证**

```powershell
crm-cli use www; crm-cli auth status
```

Expected: 输出含「SNI / 未备案」，且不含「已切换/已降级」。

- [ ] **Step 5: 包校验**

```powershell
cd D:\system\CRM-ai-native\packages\crm-native-cli; npm pack --dry-run
```

Expected: 仅含 `src`、`README.md`、`package.json`（无凭据、无 .env）。

- [ ] **Step 6: Commit（如有修正）**

---

## 自检（Spec Coverage）

| 设计文档要求 | 覆盖任务 |
|---|---|
| 三档端点 prod/local/www，默认 prod | Task 2、7（use.js） |
| 生产档必须 http | Task 2（注释 + 测试） |
| www 不可达明确诊断、不静默降级 | Task 2（diagnoseUnreachable + 测试） |
| `auth login` 交互录入 + `~/.crm-cli/credentials` 0600 | Task 3 |
| 通用 `call` 转发 | Task 4、6 |
| 2 条语义化只读命令 | Task 7 |
| 写类工具前置拒绝（顺序即安全边界） | Task 5（fetch 零调用断言） |
| `cli.json` 五段 + `statusMatchJson` | Task 1 |
| 技能包 + 端点参考文档 | Task 8 |
| 既有 MCP 通道不删除 | Task 1（测试断言） |
| 端到端 + 红线 + 打包校验 | Task 9 |
