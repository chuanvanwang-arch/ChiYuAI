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
// 本脚本在发布前一次性静态穷尽三类不自洽：
//   ① 依赖缺失：import/require 的相对目标文件不存在
//   ② 导出错配：具名 import 的符号在目标模块中不存在（含 export * 递归）
//   ③ 绝对 file:// 引用：硬编码本机绝对路径（2026-09-16 新增）
//      双重危害：换机/CI 必红（不可移植）+ 测试加载的是「本机工作树」而非被测树 → 假绿。
//      实坑：全仓 18 处，14 处在 test/（test/sync 8 + test/signal 5 + test/alerts 1）。
//   ④ migrate 系列 JS 里以**字符串**引用的 .sql 是否都在 db/（2026-09-18 新增 P0 实锤）
//      这类引用不在 import 图内（readFileSync(new URL('./x.sql'))），①② 扫不到；
//      若该 .sql 未 git add（工作树有 / HEAD 无 = 「半提交」），发布源即缺文件 →
//      容器启动 node db/migrate.js 抛 ENOENT → crm-app 崩溃循环、生产 000。
//      实坑：migration-signal-contact-owner.sql（首次发布即崩，靠容器日志才定位）。
//
// 扫描范围（2026-09-16 起含 test/）：加 test/ 后实测 HEAD 树告警 1 → 12 处，
//   暴露了 7 个长期红的测试（*_TENANT 常量的消费方未随 2388361 重构同步）。
//   注意 test/ 属「非启动链路」→ 只告警不阻断（test/ 不进 release 包）。
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

const SCAN_TOPS = ['src', 'db', 'scripts', 'test'];
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

// ───────────────────────── ③ 绝对 file:// 引用（不可移植 + 假绿）─────────────────────────
const absRefs = [];
const seenAbs = new Set();
for (const file of files) {
  const src = read(file);
  const re = /['"]file:\/\/\/([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = decodeURIComponent(m[1]);
    const p = raw.replace(/\//g, path.sep);
    const key = `${rel(file)}|${raw}`;
    if (seenAbs.has(key)) continue;
    seenAbs.add(key);
    absRefs.push({
      from: rel(file),
      target: raw,
      // 指向本仓 = 最危险的一种：测试跑的是「本机工作树」而非「被测树」
      selfRef: p.toLowerCase().startsWith(ROOT.toLowerCase()),
    });
  }
}

// ───────────────────────── ④ SQL 字符串引用缺失（migrate 系列）─────────────────────────
// 背景（2026-09-18 生产事故，P0）：db/migrate.js 以**字符串**引用 .sql ——
//   readFileSync(new URL('./x.sql', import.meta.url))。这类引用**不在 import 图内**，
//   ①/② 两条判据扫不到；若该 .sql 忘了 git add（工作树有、HEAD 无 = 「半提交」），
//   发布包（= HEAD 的干净 worktree 导出）就缺文件 → 容器启动 node db/migrate.js 抛
//   ENOENT → crm-app 崩溃循环、生产 000。实测：migration-signal-contact-owner.sql 即此形态。
// 判据：migrate 系列 JS 内出现的每个 '<name>.sql' 字面量，必须在 db/ 下真实存在。
//   注：本检查在**发布源**上执行，而发布源是 HEAD 的检出 ⇒ 「磁盘存在」即等价于「已提交」。
const sqlRefs = [];
{
  const migRe = /(^|\/)db\/migrate(-config)?\.js$/;
  const seenSql = new Set();
  for (const file of files) {
    if (!migRe.test(rel(file))) continue;
    const src = read(file);
    const re = /['"]([A-Za-z0-9._-]+\.sql)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1];
      const key = `${rel(file)}|${name}`;
      if (seenSql.has(key)) continue;
      seenSql.add(key);
      if (!existsSync(path.join(ROOT, 'db', name))) sqlRefs.push({ from: rel(file), name });
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

const cAbs = absRefs.filter((d) => isCritical(d.from));
const wAbs = absRefs.filter((d) => !isCritical(d.from));
printBlock(`❌ ③ 绝对 file:// 引用 ${cAbs.length} 处【阻断·启动链路】`, cAbs,
  (d) => `   ${d.from}\n       -> ${d.target}\n       ⚠ 硬编码绝对路径，生产环境不存在该路径`);
printBlock(`⚠️  ③ 绝对 file:// 引用 ${wAbs.length} 处【告警·不可移植】`, wAbs,
  (d) => `   ${d.from}  ->  ${d.target}${d.selfRef ? '  ⚠指向本仓工作树' : ''}`);
printBlock(`❌ ④ migrate 引用的 .sql 缺失 ${sqlRefs.length} 处【阻断·启动链路 ENOENT 崩溃】`, sqlRefs,
  (d) => `   ${d.from}  ->  db/${d.name}   ⚠ 文件不存在 ⇒ 发布包缺失，容器启动即崩（半提交特征）`);

if (cMissing.length === 0 && cMis.length === 0 && cAbs.length === 0 && sqlRefs.length === 0) {
  const warnN = wMissing.length + wMis.length + wAbs.length;
  console.log(warnN === 0
    ? '✅ 发布源自洽：依赖完整、导出符号匹配、无绝对路径引用'
    : `✅ 启动链路自洽，可发布（另有 ${warnN} 处非启动链路告警，见上）`);
  const selfN = wAbs.filter((d) => d.selfRef).length;
  if (selfN > 0) {
    console.log(`⚠️  其中 ${selfN} 处绝对路径指向本仓工作树：这些测试在干净树/CI 上会连回`);
    console.log(`   本机工作树（而非被测树）→ 不可移植且可能「假绿」。建议改为相对路径。`);
  }
  process.exit(0);
}
console.log('⛔ 结论：启动链路不自洽，当前树不可发布。请补齐缺失文件 / 一并提交配套改动后重跑。');
process.exit(1);
