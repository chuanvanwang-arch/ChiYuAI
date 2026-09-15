#!/usr/bin/env node
// scripts/verify-release-source.mjs — 发布源自洽性校验（防止「半提交状态」被发布到生产）
//
// 背景（2026-09-15 实锤 P0 事故）：
//   release 由 pack-local.py 按目录遍历打包、不读 git。当工作树处于「已提交代码引用了
//   未提交文件」的半提交状态时，用干净 worktree（git worktree add --detach）做发布源会
//   得到不自洽的树 → 生产容器启动即崩：
//     · ENOENT: /app/db/migration-calibration-sla.sql（文件未提交，但 migrate.js 已引用）
//     · ERR_MODULE_NOT_FOUND: /app/src/http/discoveryRoutes.js（新文件未提交）
//     · SyntaxError: routes.js 导入 configRouter.js 未导出的 createIntegrationProviderRouter
//       （已跟踪文件的配套改动未一起提交）
//   Node 的模块解析失败是「第一个错即停」，逐个试错要发布 4 次才发现全部问题。
//
// 本脚本在发布前一次性静态穷尽两类不自洽：
//   ① 依赖缺失：import/require 的相对目标文件不存在
//   ② 导出错配：具名 import 的符号在目标模块中不存在（含 export * 递归）
//
// 用法:
//   node scripts/verify-release-source.mjs [root]      # 默认仓库根（脚本上两级）
//   退出码 0 = 自洽可发布；1 = 存在缺陷；3 = 扫描异常（root 无效）
//
// ⚠ 向原生 node.exe 传参务必用 Windows 形式（D:/...）；MSYS 形式 /d/... 会导致
//   readdirSync 静默失败，脚本会以「0 文件」误判为自洽（假绿），故此处显式拦截。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, '..'));

const SCAN_TOPS = ['src', 'db', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'uploads', 'docs', 'dist']);

// ───────────────────────── 收集文件 ─────────────────────────
const files = [];
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); }
    else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p);
  }
}
for (const top of SCAN_TOPS) walk(path.join(ROOT, top));

if (files.length === 0) {
  console.error(`❌ 未扫描到任何文件：root 无效或不可读 -> ${ROOT}`);
  console.error('   常见原因：向原生 node.exe 传了 MSYS 形式路径 /d/...，应传 D:/...');
  process.exit(3);
}

const srcCache = new Map();
const read = (f) => {
  if (!srcCache.has(f)) { try { srcCache.set(f, readFileSync(f, 'utf8')); } catch { srcCache.set(f, ''); } }
  return srcCache.get(f);
};
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function resolveModule(fromFile, spec) {
  const exts = ['', '.js', '.mjs', '.cjs', '.json', '.sql',
                path.join('/', 'index.js'), path.join('/', 'index.mjs')];
  const cands = [];
  const base = path.resolve(path.dirname(fromFile), spec);
  // root 相对回退：部分部署辅助脚本按「项目根为 cwd」书写相对路径
  // （如 scripts/tencent-lighthouse-deploy/seed-llm-key.js 的 ./src/llm/secret.js），
  // 静态分析无法得知运行期 cwd，故同时按根相对试一次，避免误报。
  const rbase = path.resolve(ROOT, spec.replace(/^\.\//, ''));
  for (const e of exts) { cands.push(base + e, rbase + e); }
  for (const c of cands) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// ───────────────────────── ① 依赖缺失 ─────────────────────────
const missing = [];
const seenMissing = new Set();
for (const file of files) {
  const src = read(file);
  const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    if (resolveModule(file, m[1])) continue;
    const key = `${rel(file)}|${m[1]}`;
    if (seenMissing.has(key)) continue;
    seenMissing.add(key);
    missing.push({ from: rel(file), spec: m[1] });
  }
}

// ───────────────────────── ② 导出错配 ─────────────────────────
const exportCache = new Map();
function exportsOf(file, depth = 0) {
  if (exportCache.has(file)) return exportCache.get(file);
  const out = new Set(['default']); // default 总视为可能存在，避免误报
  exportCache.set(file, out);
  if (depth > 6) return out;
  const src = read(file);
  let m;
  const decl = /^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = decl.exec(src))) out.add(m[1]);
  const named = /^\s*export\s*\{([^}]*)\}/gm;
  while ((m = named.exec(src))) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.match(/^(\S+?)\s+as\s+(\S+)$/);
      out.add(as ? as[2] : t);
    }
  }
  const star = /^\s*export\s*\*\s*from\s*['"](\.[^'"]+)['"]/gm;
  while ((m = star.exec(src))) {
    const t = resolveModule(file, m[1]);
    if (t) for (const s of exportsOf(t, depth + 1)) out.add(s);
  }
  return out;
}

const mismatches = [];
for (const file of files) {
  const src = read(file);
  const re = /^\s*import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(src))) {
    const target = resolveModule(file, m[2]);
    if (!target) continue; // 由 ① 负责
    const avail = exportsOf(target);
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t || t.startsWith('type ') || t.startsWith('//') || t.startsWith('/*')) continue;
      const as = t.match(/^(\S+?)\s+as\s+(\S+)$/);
      const name = as ? as[1] : t;
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue; // 注释/非法标识符跳过
      if (!avail.has(name)) mismatches.push({ file: rel(file), target: rel(target), name });
    }
  }
}

// ───────────────────────── 分级：是否在 app 启动链路上 ─────────────────────────
// 只有启动链路的不自洽才会让生产容器崩溃循环（实测三次崩溃均来自 src/ 与 db/migrate.js）；
// scripts/ 下的独立脚本、db/seed/ 下的种子脚本坏引用属既有技术债，不阻断发布，
// 单独作为告警输出，避免噪音掩盖真正阻断项。
const isCritical = (file) => file.startsWith('src/') || /^db\/migrate(-config)?\.js$/.test(file);

// ───────────────────────── 报告 ─────────────────────────
console.log(`发布源自洽性校验  root=${ROOT}`);
console.log(`扫描 ${files.length} 个 .js/.mjs/.cjs 文件\n`);

const cMissing = missing.filter((d) => isCritical(d.from));
const wMissing = missing.filter((d) => !isCritical(d.from));
const cMis = mismatches.filter((d) => isCritical(d.file));
const wMis = mismatches.filter((d) => !isCritical(d.file));

const printBlock = (title, arr, fmt) => {
  if (!arr.length) return;
  console.log(title);
  for (const d of arr) console.log(fmt(d));
  console.log('');
};

printBlock(`❌ ① 依赖缺失 ${cMissing.length} 处【阻断·启动链路】`, cMissing,
  (d) => `   ${d.from}\n       -> ${d.spec}`);
printBlock(`❌ ② 导出错配 ${cMis.length} 处【阻断·启动链路】`, cMis,
  (d) => `   ${d.file}\n       import { ${d.name} } from '${d.target}'`);
printBlock(`⚠️  ① 依赖缺失 ${wMissing.length} 处【告警·非启动链路】`, wMissing,
  (d) => `   ${d.from}  ->  ${d.spec}`);
printBlock(`⚠️  ② 导出错配 ${wMis.length} 处【告警·非启动链路】`, wMis,
  (d) => `   ${d.file}  import { ${d.name} } from '${d.target}'`);

if (cMissing.length === 0 && cMis.length === 0) {
  const warnN = wMissing.length + wMis.length;
  console.log(warnN === 0
    ? '✅ 发布源自洽：依赖完整、导出符号匹配'
    : `✅ 启动链路自洽，可发布（另有 ${warnN} 处非启动链路告警，见上）`);
  process.exit(0);
}
console.log('⛔ 结论：启动链路不自洽，当前树不可发布。请补齐缺失文件 / 一并提交配套改动后重跑。');
process.exit(1);
