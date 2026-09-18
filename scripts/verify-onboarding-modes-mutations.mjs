// scripts/verify-onboarding-modes-mutations.mjs — 向导三形态断言的**变异自证**（判据⑬）
//
// 为什么需要：`verify-onboarding-guide-hints.mjs` 全绿只说明「按现在的写法跑通了」，不说明它有鉴别力。
//   本脚本注入「实现者最可能犯的错」，断言探针**必须变红**；全绿则守卫是假绿。
//
// 变异清单：
//   m1 A/B 路径也提交凭据（形态只剩标签：仍回「网页收密码」）
//   m2 pending 被显示成「平台侧探测通过」（把未验证说成已验证）
//   m3 默认落在 C 平台直连（用户第一眼看到的是密码框 —— 正是用户指出的偏差）
//   m4 本机桥命令写死示例邮箱（用户照抄必然失败）
//
// 用法：node scripts/verify-onboarding-modes-mutations.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FILE = 'src/web/onboarding-guide.html';
const PROBE = 'scripts/verify-onboarding-guide-hints.mjs';

const MUTATIONS = [
  {
    id: 'm1', desc: 'A/B 路径也提交凭据（形态只剩标签＝仍是网页收密码）',
    from: "key: cb.value, kind: cb.value, label: KIND_LABEL[cb.value] || cb.value, credentials: null,",
    to: "key: cb.value, kind: cb.value, label: KIND_LABEL[cb.value] || cb.value, credentials: { user: 'leak', pass: 'leak' },",
  },
  {
    id: 'm2', desc: 'pending 显示成「平台侧探测通过」（未验证说成已验证）',
    from: "res.pending ? '⏳ 已受理，待你在自己那侧确认'",
    to: "res.pending ? '✅ 平台侧探测通过'",
  },
  {
    id: 'm3', desc: '默认路径改成 C 平台直连（第一眼就是密码框）',
    from: "let mode = 'connector';",
    to: "let mode = 'direct';",
  },
  {
    id: 'm4', desc: '本机桥命令写死示例邮箱（不是按用户填的生成）',
    from: "const email = (el && el.value.trim()) || 'you@163.com';",
    to: "const email = 'you@163.com';",
  },
];

const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');
const original = readFileSync(FILE, 'utf8');
const originalMd5 = md5(FILE);

console.log('=== 向导三形态：变异自证（判据⑬）===\n');
let killed = 0;
for (const mu of MUTATIONS) {
  if (!original.includes(mu.from)) { console.log(`⚪ ${mu.id} 锚点缺失（实现已变，脚本需同步）`); continue; }
  try {
    writeFileSync(FILE, original.split(mu.from).join(mu.to), 'utf8');
    const r = spawnSync(process.execPath, [PROBE], { encoding: 'utf8', env: { ...process.env } });
    const red = r.status !== 0;
    if (red) { killed++; console.log(`🔴 ${mu.id} 已被杀掉 ✅（${mu.desc}）`); }
    else { console.log(`⛔ ${mu.id} 变异存活 = 断言无鉴别力（${mu.desc}）`); }
  } finally {
    writeFileSync(FILE, original, 'utf8');
  }
}
const restored = md5(FILE) === originalMd5;
console.log(`\n恢复校验：${restored ? '✅ 文件 md5 与本轮开始时一致' : '⛔ 内容已变'}`);
console.log(`变异被杀：${killed}/${MUTATIONS.length}`);
const okAll = killed === MUTATIONS.length && restored;
console.log(okAll ? '\n✅ 全部变异被杀 —— 三形态断言具备鉴别力' : '\n⛔ 存在存活变异 —— 守卫是假绿，必须补断言');
process.exit(okAll ? 0 : 1);
