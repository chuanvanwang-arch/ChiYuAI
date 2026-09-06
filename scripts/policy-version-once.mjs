// C3 策略版本治理自查（运维手工入口）
// 用法：
//   node scripts/policy-version-once.mjs                 # 默认生产库 crm_native
//   PGDATABASE=crm_native_test node scripts/policy-version-once.mjs
//   node scripts/policy-version-once.mjs --resolve       # 额外解析并落一次当前版本（写 operation）
//
// 回答三个治理问题：
//   ① 现在生效的是哪一版配置？（currentPolicyVersion）
//   ② 有多少决策**没有**版本锚点？（effective_policy_version IS NULL → 事后改配置即洗掉判定依据）
//   ③ 版本线是否连续？（effective_to 未封版的行应至多一条/租户；多条 = 封版逻辑失效）
// --resolve 会 INSERT crm.policy_version（内容哈希幂等；配置未变则不产生新行），用于首次通电。
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';

const { query } = await import('../src/db.js');
const { currentPolicyVersion, resolvePolicyVersion, POLICY_KEYS } = await import('../src/decision/policyVersion.js');

const wantResolve = process.argv.includes('--resolve');

console.log(`[policy] database=${process.env.PGDATABASE}`);

if (wantResolve) {
  const r = await resolvePolicyVersion({ tenantId: 'system' });
  console.log(`[policy] resolve → ${r.policy_version_id} (${r.created ? '新建' : '复用'})`);
}

const total = (await query(`SELECT count(*)::int AS n FROM crm.decision`)).rows[0].n;
const anchored = (await query(
  `SELECT count(*)::int AS n FROM crm.decision WHERE effective_policy_version IS NOT NULL`
)).rows[0].n;
const versions = (await query(`SELECT count(*)::int AS n FROM crm.policy_version`)).rows[0].n;
const cur = await currentPolicyVersion({ tenantId: 'system' });

console.log(`[policy] 决策总数 ${total} | 有版本锚点 ${anchored} | 覆盖率 ${total ? ((anchored / total) * 100).toFixed(1) : '0.0'}%`);
console.log(`[policy] policy_version 行数 ${versions}`);
console.log(`[policy] 当前生效版本: ${cur ? cur.policy_version_id : '（无）'}`);
if (cur) console.log(`[policy]   生效自 ${cur.effective_from} / version=${cur.version}`);

// 版本线连续性：同 policy_id 下未封版应至多一条
const open = (await query(
  `SELECT policy_id, count(*)::int AS n FROM crm.policy_version WHERE effective_to IS NULL
   GROUP BY policy_id HAVING count(*) > 1`
)).rows;
if (open.length) {
  console.log(`[policy] ⚠ 未封版版本多于一条（封版逻辑失效）: ${JSON.stringify(open)}`);
}

// 快照逐键状态：null = 未配置（消费方走出厂兜底），不是缺陷
if (cur) {
  const keys = cur.snapshot?.keys || {};
  const unset = POLICY_KEYS.filter((k) => keys[k] === null || keys[k] === undefined);
  console.log(`[policy] 快照 6 键：已配置 ${POLICY_KEYS.length - unset.length}/${POLICY_KEYS.length}` +
    (unset.length ? `，未配置（走出厂兜底）：${unset.join(', ')}` : ''));
}

const gap = total - anchored;
if (gap > 0) {
  console.log(`\n[policy] ⚠ ${gap} 条决策无版本锚点：这些决策的判定依据在配置变更后无法追溯。` +
    `\n[policy]   注：pv-test-001 类 id 为 e2e 脚本伪造产物，不计入真实覆盖。`);
}
process.exit(0);
