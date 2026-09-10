// 每日采样：把三系统健康指标快照 upsert 入 crm.system_overview_sample
// 触发：每晚 10 点例行自动化新增一步；或独立 cron `node scripts/sample-system-overview.mjs`
//
// 结构：computeMetrics(tenantId, deps) 纯计算（可注入数据源，便于测试）；
//       sampleTenant / sampleAll 负责 DB 写。无 DB 时各查询均 .catch 降级，不阻断。
import { query, queryWrite } from '../src/db.js';
import { listSkillRegistry } from '../src/skills/skillRegistry.js';
import { getGateAttribution } from '../src/monitor/monitorStore.js';

function sumGateTotal(gates) {
  const arr = Array.isArray(gates) ? gates : (gates?.gates || []);
  return arr.reduce((s, g) => s + (Number(g.total) || 0), 0);
}

// 纯计算：给定数据源依赖，返回 [{metric, value}]
export async function computeMetrics(tenantId, deps = {}) {
  const listSkill = deps.listSkillRegistry || listSkillRegistry;
  const gateAttr = deps.getGateAttribution || getGateAttribution;
  const q = deps.query || query;

  const skills = await listSkill().catch(() => []);
  const kMethod = skills.filter((s) => s.methodology_id != null).length;

  const mRes = await q(
    `SELECT COUNT(*)::int AS n
     FROM crm.decision_precedent_rel r
     JOIN crm.decision d ON r.decision_id = d.decision_id
     WHERE d.tenant_id = $1`, [tenantId]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  const mPrecedent = Number(mRes.rows?.[0]?.n ?? 0);

  const gates = await gateAttr(tenantId).catch(() => []);
  const dL1 = sumGateTotal(gates);

  return [
    { metric: 'k_method_skill', value: kMethod },
    { metric: 'm_precedent_edge', value: mPrecedent },
    { metric: 'd_l1_intercept', value: dL1 },
  ];
}

export async function sampleTenant(tenantId, today, deps = {}) {
  const qw = deps.queryWrite || queryWrite;
  const metrics = await computeMetrics(tenantId, deps);
  for (const { metric, value } of metrics) {
    await qw(
      `INSERT INTO crm.system_overview_sample (tenant_id, sample_date, metric, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, sample_date, metric) DO UPDATE SET value = EXCLUDED.value`,
      [tenantId, today, metric, value]
    );
  }
  return metrics.length;
}

export async function sampleAll(deps = {}) {
  const q = deps.query || query;
  const qw = deps.queryWrite || queryWrite;
  const today = new Date().toISOString().slice(0, 10);
  const tRes = await q(`SELECT tenant_id FROM crm.tenants`).catch(() => ({ rows: [] }));
  const tenants = ['system', ...(tRes.rows || []).map((r) => r.tenant_id)];
  for (const t of tenants) {
    await sampleTenant(t, today, { ...deps, query: q, queryWrite: qw });
  }
  return tenants.length;
}

// 直接执行入口（非 import 时运行）
if (import.meta.url === `file://${process.argv[1]}`) {
  sampleAll()
    .then((n) => { console.log(`[sample-overview] upserted ${n} tenants`); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
