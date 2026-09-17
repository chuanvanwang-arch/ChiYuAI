// scripts/verify-home-onboard-banner.mjs — 首页「首次接入引导」的**运行期**验证器
//
// 为什么需要：静态断言只能证明「代码里有这段」，证明不了**它按真实通道数正确开合**。
//   本仓头号形态：grep 全绿而页面永远空白/永远常驻。引导条一旦常驻就是噪音，一旦永不出现就回到
//   「要用户自己去翻配置页」——两者都不是 grep 能发现的。
// 做法：从 src/web/index.html 抽出「首次接入引导」那一段 IIFE，注入最小 DOM 桩与 get 桩，
//   落入 tmp/ 后真实 import 执行；断言 ① 零通道 → 展示 ② 有通道 → 收起 ③ 按钮跳向导。
// 零新依赖（仓 vitest 跑 node env，无 jsdom）、不触网、不连库、不启动服务。
//
// 用法：
//   node scripts/verify-home-onboard-banner.mjs                    # 验真实页面
//   HOME_HTML=tmp/_mut.html node scripts/verify-home-onboard-banner.mjs   # 验变异体（自证鉴别力）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const htmlRel = process.env.HOME_HTML || 'src/web/index.html';
const html = readFileSync(new URL(htmlRel, ROOT), 'utf8');
console.log('被测页面:', htmlRel);

let failures = 0;
function ok(cond, msg) { console.log((cond ? '  ✅ ' : '  🔴 ') + msg); if (!cond) failures++; }

// ── 抽取引导 IIFE（锚点：getElementById('onboard-banner')）──
const m = html.match(/\(async \(\) => \{\s*const box = document\.getElementById\('onboard-banner'\);[\s\S]*?\}\)\(\);/);
if (!m) { console.log('🔴 未找到首页引导 IIFE（锚点失效）'); process.exit(1); }
const snippet = m[0];

const STUB = `
const __handlers = {};
function mkEl(id) {
  return {
    id, hidden: null, innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener(ev, fn) { (__handlers[id] ||= {})[ev] = fn; },
    setAttribute() {}, getAttribute() { return null; }, appendChild(c) { return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
globalThis.__handlers = __handlers;
globalThis.__els = { 'onboard-banner': mkEl('onboard-banner'), 'goOnboard': mkEl('goOnboard') };
globalThis.document = {
  getElementById: (id) => globalThis.__els[id] || null,
  createElement: (t) => mkEl(t), querySelector: () => null, querySelectorAll: () => [],
};
globalThis.location = { href: 'http://localhost/index.html', pathname: '/index.html', search: '' };
globalThis.get = globalThis.__get;
`;

function runCase(name, channelsResp) {
  const dir = new URL('tmp/', ROOT);
  mkdirSync(fileURLToPath(dir), { recursive: true });
  const file = new URL(`_home_banner_${name}.mjs`, dir);
  const body = [
    '// 自动生成（探针产物，勿手改）',
    `globalThis.__get = async (url) => { ${
      channelsResp === '__THROW__'
        ? "throw new Error('channel api down');"
        : `if (url === '/api/channels') return ${JSON.stringify(channelsResp)}; throw new Error('unexpected url ' + url);`
    } };`,
    STUB,
    // ⚠ 必须 await 到**内层 IIFE 的 promise**：被抽出的片段本身就是 `(async () => {...})();`，
    //   若再包一层不 await 的外壳，内部抛错会变成 unhandled rejection —— 探针直接崩栈、
    //   而不是给出可读的 🔴（变异②实测踩到）。此处去掉尾分号后直接 await 其返回值。
    'await (' + snippet.replace(/;\s*$/, '') + ');',
  ].join('\n');
  writeFileSync(file, body, 'utf8');
  return import(pathToFileURL(fileURLToPath(file)).href + '?v=' + Date.now());
}

console.log('场景 A：本租户零通道 → 引导必须出现');
await runCase('zero', { items: [] });
{
  const box = globalThis.__els['onboard-banner'];
  ok(box.hidden === false, '引导可见（hidden=false）——零通道时用户一登录就看到接入入口');
  const fn = globalThis.__handlers['goOnboard']?.click;
  ok(typeof fn === 'function', '「开始 3 步接入向导」按钮已绑事件');
  globalThis.location.href = '';
  if (typeof fn === 'function') fn();
  ok(globalThis.location.href === '/onboarding-guide.html', '点击后跳到接入向导（不是配置页）');
}

console.log('场景 B：已接通 ≥1 通道 → 引导必须收起（不许常驻噪音）');
await runCase('has', { items: [{ id: 'ch-1', kind: 'generic-email' }] });
ok(globalThis.__els['onboard-banner'].hidden === true, '引导已收起（hidden=true）');

console.log('场景 C：接口抛错 → 静默降级，不得把异常抛到顶层（否则整页脚本中断）');
let threw = false;
try {
  await runCase('err', '__THROW__');
} catch { threw = true; }
ok(!threw, '异常未被抛出（引导段自己吞掉，首页 S02 出片不受接入面故障影响）');
ok(globalThis.__els['onboard-banner'].hidden === null, '异常时保持原状（不误判为「已接通」而收起）');

console.log(failures === 0 ? '\n✅ 全部通过' : `\n🔴 ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
