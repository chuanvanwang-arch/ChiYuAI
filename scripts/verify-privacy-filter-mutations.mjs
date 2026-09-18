// scripts/verify-privacy-filter-mutations.mjs — P1 隐私过滤的**变异自证**（设计 §10 判据 + 判据⑬）
//
// 为什么必须有这个脚本：单测全绿只证明「按我写的方式跑通了」，不证明这套断言**有鉴别力**。
//   一个把过滤放在 upsert 之后（「落库后再隐藏」）的实现，同样能让「计数=3」的断言通过。
//   本脚本逐个注入「实现者最可能犯的错」，断言测试**必须变红**；全绿则守卫是假绿。
//
// 变异清单（每条对应一个真实可犯的错误）：
//   m1 同步线：过滤不再 continue（副作用已发生 → 等价于「写在入口之后」）
//   m2 通道线：同上
//   m3 同步线：信号抽取恒为空（过滤被调用但永不命中 → 形同虚设，最隐蔽的一种假绿）
//   m4 webhook 入口：不判定（只在定时器路径过滤 → 留下一条旁路）
//
// 用法：node scripts/verify-privacy-filter-mutations.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const TESTS = ['test/channels/privacyFilter.test.js', 'test/sync/privacyWiring.test.js'];
const TARGETS = [
  'src/sync/engine.js',
  'src/channels/channelIngestWiring.js',
  'src/sync/mount.js',
];

const MUTATIONS = [
  {
    id: 'm1', file: 'src/sync/engine.js', desc: '同步线：过滤不 continue（副作用已发生＝过滤写在入口之后）',
    from: '          byReason[d.reason] = (byReason[d.reason] || 0) + 1;\n          continue;',
    to: '          byReason[d.reason] = (byReason[d.reason] || 0) + 1;\n          void 0;',
  },
  {
    id: 'm2', file: 'src/channels/channelIngestWiring.js', desc: '通道线：过滤不 continue',
    from: '              byReason[d.reason] = (byReason[d.reason] || 0) + 1;\n              continue;',
    to: '              byReason[d.reason] = (byReason[d.reason] || 0) + 1;\n              void 0;',
  },
  {
    id: 'm3', file: 'src/sync/engine.js', desc: '同步线：信号恒为空（判定被调用但永不命中）',
    from: '        const d = pf.evaluate(signalsFromSyncRow(row));',
    to: '        const d = pf.evaluate({});',
  },
  {
    id: 'm4', file: 'src/sync/mount.js', desc: 'webhook 入口：跳过判定（只留定时器路径＝留旁路）',
    from: '  const pf = privacy || await loadPrivacyFilter({ tenantId, readConfig });\n  if (pf && !pf.isEmpty) {',
    to: '  const pf = privacy || await loadPrivacyFilter({ tenantId, readConfig });\n  if (false) {',
  },
];

const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');
const originals = new Map(TARGETS.map((p) => [p, readFileSync(p, 'utf8')]));
const originalMd5 = new Map(TARGETS.map((p) => [p, md5(p)]));

function runTests() {
  const r = spawnSync(process.execPath, ['./node_modules/vitest/vitest.mjs', 'run', ...TESTS, '--reporter=dot'], {
    encoding: 'utf8', cwd: process.cwd(), env: { ...process.env },
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  return { failed: r.status !== 0, tail: out.trim().split('\n').slice(-6).join('\n') };
}

console.log('=== P1 隐私过滤：变异自证（判据⑬：探针必须能杀掉变异）===\n');
let killed = 0;
const results = [];
for (const m of MUTATIONS) {
  const src = originals.get(m.file);
  if (!src.includes(m.from)) {
    console.log(`⚪ ${m.id} 锚点缺失（实现已变，脚本需同步）: ${m.file}`);
    results.push({ id: m.id, ok: false, note: 'anchor_missing' });
    continue;
  }
  try {
    writeFileSync(m.file, src.split(m.from).join(m.to), 'utf8');
    const r = runTests();
    if (r.failed) { killed++; console.log(`🔴 ${m.id} 已被杀掉 ✅（${m.desc}）`); }
    else { console.log(`⛔ ${m.id} 变异存活 = 断言无鉴别力（${m.desc}）`); }
    results.push({ id: m.id, ok: r.failed, note: r.failed ? 'killed' : 'survived' });
  } finally {
    writeFileSync(m.file, src, 'utf8');
  }
}

// 还原证明：三个文件必须与本轮开始时逐字节一致（否则脚本本身在污染源码）
let restored = true;
for (const p of TARGETS) {
  if (md5(p) !== originalMd5.get(p)) { restored = false; console.log(`⛔ 还原失败（内容已变）：${p}`); }
}
console.log(`\n恢复校验：${restored ? '✅ 三文件 md5 与本轮开始时一致' : '⛔ 不一致'}`);
console.log(`变异被杀：${killed}/${MUTATIONS.length}`);
const ok = killed === MUTATIONS.length && restored;
console.log(ok ? '\n✅ 全部变异被杀 —— 断言具备鉴别力' : '\n⛔ 存在存活变异 —— 守卫是假绿，必须补断言');
process.exit(ok ? 0 : 1);
