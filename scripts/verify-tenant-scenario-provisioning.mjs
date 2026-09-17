// scripts/verify-tenant-scenario-provisioning.mjs
// E7-2 取证探针：**生产路径**是否真的为「本租户无场景行」的租户按需物化决策场景。
//   （命名用 verify- 而非 probe-：`probe-*.mjs` 在 .gitignore:95 里，而本脚本是设计文档
//     E.7 引用的**独立取证仪器**，必须随仓库入库，否则引用会指向一个不在树里的文件。）
//
// 为什么需要独立探针（而不是靠 grep 代码/靠集成测试转绿）：
//   本仓已反复踩过「传了≠接了」「替身缺省值反向定义契约」两类假绿。本探针的证据形态是
//   **真实入口 + 全新租户 + 真实约束**：
//     · 入口用 `createDecision`（生产铸决策的唯一落库函数），不 mock、不注入替身；
//     · 租户 id 每次运行**全新**（含时间戳）⇒ 上一轮物化结果无法让本轮"碰巧通过"；
//     · 附带**负向控制**：对同一租户插入一个「system 模板里不存在」的场景 → 必须违外键。
//       若该控制不红，说明约束已被删除 ⇒ 主结论（"没违例"）不成立（防 vacuous pass）。
//
// ⚠ 只能跑测试库：脚本首步 fail-closed 校验 PGDATABASE 后缀（2026-09-17 曾因漏设 PGDATABASE
//   把探针写进本地主库 crm_native，此处即该事故的护栏）。
// ⚠ 本探针**会留下残留**（测试库内 1 个合成租户的 1 个场景行 + 1 个 decision 行；`crm.decision` 经
//   全局连接池写入，无法包在可回滚事务里）。残留只落在测试库、只属合成租户；
//   清理需 DELETE（本仓红线）⇒ 需人工批准，脚本只**报告**残留计数，不自行清理。
import { pool, query } from '../src/db.js';
import { createDecision } from '../src/decision/decisionRepo.js';

const SCENARIO = 'PARTICLE_CREATE'; // system 字典里必存在
const GHOST_SCENARIO = 'E7_2_NONEXISTENT_SCENARIO_FOR_NEGATIVE_CONTROL';

function die(msg) { console.error(`FAIL ${msg}`); process.exitCode = 1; }
const ok = (msg) => console.log(`PASS ${msg}`);

// ── 0. 库定位 fail-closed（防污染主库）────────────────────────────────────
const dbName = (await query('SELECT current_database() AS d')).rows[0].d;
if (!/_test$/.test(dbName)) {
  console.error(`ABORT 目标库为「${dbName}」，非测试库（须以 _test 结尾）。本探针只允许跑测试库。`);
  process.exit(2);
}
ok(`目标库 = ${dbName}（测试库校验通过）`);

const TENANT = `test-tenant-e7-2-${Date.now()}`;
console.log(`# 本轮全新租户 = ${TENANT}`);

// ── 1. 前置：全新租户确实零场景行 ────────────────────────────────────────
const pre = (await query('SELECT count(*)::int n FROM crm.decision_scenario WHERE tenant_id=$1', [TENANT])).rows[0].n;
pre === 0 ? ok('前置：全新租户的决策场景行 = 0（主结论不会靠残留"碰巧通过"）') : die(`前置失败：全新租户已有 ${pre} 行场景`);

// ── 2. 负向控制：约束必须仍然生效（否则主结论是 vacuous）────────────────
try {
  await createDecision({
    scenario_id: GHOST_SCENARIO, tenantId: TENANT, disposition: 'APPROVE',
    decider_type: 'AUTONOMOUS_AGENT', rationale: 'probe negative control', business_tier: 'NORMAL',
  });
  die(`负向控制未红：不存在的场景 ${GHOST_SCENARIO} 竟然插入成功 ⇒ 复合外键已失效，主结论不成立`);
} catch (e) {
  const m = String(e?.message || e);
  /decision_scenario_tenant_fkey/.test(m)
    ? ok('负向控制：不存在场景 → 违 decision_scenario_tenant_fkey（约束真实生效）')
    : die(`负向控制红得不对：期望外键违例，实得「${m.slice(0, 160)}」`);
}

// ── 3. 主结论：真实 createDecision 对全新租户应成功，并落下本租户场景行 ──
let decisionId = null;
try {
  const d = await createDecision({
    scenario_id: SCENARIO, tenantId: TENANT, disposition: 'APPROVE',
    decider_type: 'AUTONOMOUS_AGENT', rationale: 'probe: E7-2 lazy scenario provisioning',
    business_tier: 'NORMAL', trigger_context: { source: 'probe-e7-2' },
    involved_entities: [], conditions_evaluated: [],
  });
  decisionId = d?.decision_id || null;
} catch (e) {
  die(`真实 createDecision 抛错（期望成功）：${String(e?.message || e).slice(0, 240)}`);
}

if (decisionId) {
  const scen = (await query('SELECT count(*)::int n FROM crm.decision_scenario WHERE tenant_id=$1 AND scenario_id=$2', [TENANT, SCENARIO])).rows[0].n;
  const dec = (await query('SELECT count(*)::int n FROM crm.decision WHERE tenant_id=$1 AND scenario_id=$2', [TENANT, SCENARIO])).rows[0].n;
  scen === 1 ? ok(`生产路径物化了本租户场景行（decision_scenario tenant=${TENANT} scenario=${SCENARIO} → 1 行）`)
    : die(`未物化：本租户场景行 = ${scen}（期望 1）`);
  dec >= 1 ? ok(`decision 行已落库（${dec} 行，decision_id=${decisionId}）`)
    : die(`decision 行未落库（${dec} 行）`);
}

// ── 4. 残留报告（不自行清理）─────────────────────────────────────────────
const res = (await query(
  `SELECT (SELECT count(*)::int FROM crm.decision WHERE tenant_id=$1) AS decisions,
          (SELECT count(*)::int FROM crm.decision_scenario WHERE tenant_id=$1) AS scenarios`,
  [TENANT]
)).rows[0];
console.log(`# 残留（测试库、合成租户 ${TENANT}）：decision=${res.decisions} 行，decision_scenario=${res.scenarios} 行`);
console.log('# 如需清理须人工批准 DELETE（本仓红线，脚本不自行执行）');

await pool.end();
console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS');
