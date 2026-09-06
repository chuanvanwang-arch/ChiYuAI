// G3 (修正版): 将页面裸 fetch 收口到 /portal/api.js 的 get/post/put。
// 关键修正：URL / body 捕获用 [^,{}()] 边界，杜绝跨多个 fetch 调用的跨行匹配。
// 仅转换安全惯用法；每文件 node --check 语法校验，失败则从 backup 还原（不保留破损）。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const NODE = process.env.HOME + '/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const dir = 'src/web';
const BACKUP = 'tmp/web-backup';
const VAR = '[A-Za-z_$][\\w$]*';
const URLCAP = '[^,{}()]+?';          // URL 不带逗号/花括号/括号
const BODYCAP = '(?:[^()]*|\\([^()]*\\))*'; // body 允许一层括号

const DRY = process.env.DRY === '1';

function transform(code) {
  let out = code;
  // T2: 两行 GET 惯用法（URL 无逗号）
  out = out.replace(
    new RegExp(`const\\s+(${VAR})\\s*=\\s*await\\s+fetch\\(\\s*(${URLCAP}),\\s*\\{\\s*headers:\\s*authH\\s*\\}\\s*\\);\\s*\\n\\s*const\\s+(${VAR})\\s*=\\s*await\\s+\\1\\.json\\(\\);`, 'g'),
    (_, _r, url, j) => `const ${j} = await get(${url.trim()});`
  );
  // T3: 两行 POST 惯用法
  out = out.replace(
    new RegExp(`const\\s+(${VAR})\\s*=\\s*await\\s+fetch\\(\\s*(${URLCAP}),\\s*\\{\\s*method:\\s*['"]POST['"],\\s*headers:\\s*\\{\\s*['"]Content-Type['"]:\\s*['"]application/json['"],\\s*\\.\\.\\.authH\\s*\\},\\s*body:\\s*JSON\\.stringify\\(\\s*(${BODYCAP})\\s*\\)\\s*\\}\\s*\\);\\s*\\n\\s*const\\s+(${VAR})\\s*=\\s*await\\s+\\1\\.json\\(\\);`, 'g'),
    (_, _r, url, body, j) => `const ${j} = await post(${url.trim()}, ${body.trim()});`
  );
  // T4: 两行 PUT 惯用法
  out = out.replace(
    new RegExp(`const\\s+(${VAR})\\s*=\\s*await\\s+fetch\\(\\s*(${URLCAP}),\\s*\\{\\s*method:\\s*['"]PUT['"],\\s*headers:\\s*\\{\\s*['"]Content-Type['"]:\\s*['"]application/json['"],\\s*\\.\\.\\.authH\\s*\\},\\s*body:\\s*JSON\\.stringify\\(\\s*(${BODYCAP})\\s*\\)\\s*\\}\\s*\\);\\s*\\n\\s*const\\s+(${VAR})\\s*=\\s*await\\s+\\1\\.json\\(\\);`, 'g'),
    (_, _r, url, body, j) => `const ${j} = await put(${url.trim()}, ${body.trim()});`
  );
  // T2b: 同行 GET 惯用法（fetch 与 .json() 同一行）
  out = out.replace(
    new RegExp(`const\\s+(${VAR})\\s*=\\s*await\\s+fetch\\(\\s*(${URLCAP}),\\s*\\{\\s*headers:\\s*authH\\s*\\}\\);\\s*const\\s+(${VAR})\\s*=\\s*await\\s+\\1\\.json\\(\\);`, 'g'),
    (_, _r, url, j) => `const ${j} = await get(${url.trim()});`
  );
  // T5: 单行 GET 链 fetch(U,{headers:authH}).then(r=>r.json())
  out = out.replace(
    new RegExp(`fetch\\(\\s*(${URLCAP}),\\s*\\{\\s*headers:\\s*authH\\s*\\}\\)\\.then\\(\\s*r\\s*=>\\s*r\\.json\\(\\)\\s*\\)`, 'g'),
    (_, url) => `get(${url.trim()})`
  );
  return out;
}

let changed = 0, syntaxFail = 0;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.html')) continue;
  if (f === 'home.html' || f === 'portal-stage3-mockup.html') continue;
  const p = path.join(dir, f);
  let s = fs.readFileSync(p, 'utf8');
  if (!/fetch\(/.test(s)) continue;
  if (/from '\/portal\/api\.js'/.test(s)) continue; // 已处理过

  let injected = false;
  let out = s.replace(/<script type="module">/, (m) => {
    if (injected) return m; injected = true;
    return `${m}\nimport { get, post, put } from '/portal/api.js';`;
  });
  out = out.replace(/<script type="module">([\s\S]*?)<\/script>/g, (_, code) => {
    return `<script type="module">${transform(code)}`;
  });
  if (out === s) continue;

  if (DRY) { console.log('DRY would change:', f); continue; }

  // 语法校验
  const m = out.match(/<script type="module">([\s\S]*?)<\/script>/);
  let ok = true;
  if (m) {
    const tmp = path.join('tmp', 'chk_' + f.replace('.html', '.mjs'));
    fs.writeFileSync(tmp, m[1]);
    try { execSync(`"${NODE}" --check "${tmp}"`, { stdio: 'pipe' }); }
    catch (e) { ok = false; console.log('SYNTAX FAIL (restored):', f); }
  }
  if (ok) { fs.writeFileSync(p, out); changed++; }
  else { fs.copyFileSync(path.join(BACKUP, f), p); } // 还原破损
}
console.log(`G3: changed=${changed} syntaxFail=${syntaxFail}`);
