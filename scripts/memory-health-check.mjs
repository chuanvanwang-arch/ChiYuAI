// scripts/memory-health-check.mjs — 记忆系统健康巡检（只读，不改数据）
//
// 回答「客户记忆到底有没有写对 / 能不能读到」的可复跑判据。7 项指标 + 缺口清单。
// 用法：
//   node scripts/memory-health-check.mjs                 # 连本地 crm_native，输出人读报告
//   node scripts/memory-health-check.mjs --json out.json # 同时落 JSON（供夜批/看板消费）
//   PGDATABASE=crm_native_test node scripts/memory-health-check.mjs
//
// 设计依据：docs/2026-09-10-memory-system-governance-design.md §7（健康指标）/ §8（闭环）
// 铁律：本脚本**只读**（SELECT），任何修补都走独立的 memory-backfill.mjs 且默认 dry-run。
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';
import pg from 'pg';

const db = new pg.Client(`postgres://agent2b:agent2b@localhost:5433/${process.env.PGDATABASE}`);
await db.connect();
await db.query('SET search_path TO crm,public');
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const pct = (n, d) => (d ? Number(((n / d) * 100).toFixed(2)) : 0);

// ── 1. 总量与租户分布 ────────────────────────────────────────────────────────
const total = (await q(`SELECT count(*)::int n FROM crm.memory_log`))[0].n;
const byTenant = await q(`SELECT tenant_id, count(*)::int n FROM crm.memory_log GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
const bizRows = byTenant.filter((r) => r.tenant_id !== 'system').reduce((s, r) => s + r.n, 0);

// ── 2. 锚点覆盖率（客户锚点是否真的落上了）──────────────────────────────────
const anchored = (await q(`SELECT count(*)::int n FROM crm.memory_log WHERE entity_id IS NOT NULL AND tenant_id <> 'system' AND archived IS NOT TRUE`))[0].n;
const bizActive = (await q(`SELECT count(*)::int n FROM crm.memory_log WHERE tenant_id <> 'system' AND archived IS NOT TRUE`))[0].n;

// ── 3. 投影完整率（C7：决策记忆是否含 injector 认的 summary 键）──────────────
const decTotal = (await q(`SELECT count(*)::int n FROM crm.memory_log WHERE topic LIKE 'decision:%'`))[0].n;
const decSummary = (await q(`SELECT count(*)::int n FROM crm.memory_log WHERE topic LIKE 'decision:%' AND payload ? 'summary'`))[0].n;

// ── 4. 噪声比（C4：trace 自激是否切断）──────────────────────────────────────
const noise = (await q(`SELECT count(*)::int n FROM crm.memory_log WHERE topic LIKE 'event:trace:%'`))[0].n;
const noiseActive = (await q(`SELECT count(*)::int n FROM crm.memory_log WHERE topic LIKE 'event:trace:%' AND archived IS NOT TRUE`))[0].n;
const noise24h = (await q(`SELECT count(*)::int n FROM crm.memory_log WHERE topic LIKE 'event:trace:%' AND created_at > now() - interval '24 hours'`))[0].n;

// ── 5. 注入命中率（写到读是否双向落空）──────────────────────────────────────
//    injector.js#memoryText 只认 payload.text|summary|note|content，四键全空 = 读到也吐空串
const injectable = (await q(`SELECT count(*)::int n FROM crm.memory_log
  WHERE archived IS NOT TRUE AND (
    COALESCE(payload->>'summary', payload->>'text', payload->>'note', payload->>'content', '') <> ''
  )`))[0].n;

// ── 6. 决策归属一致性（C5：决策是否还落 system）─────────────────────────────
const decByTenant = await q(`SELECT tenant_id, count(*)::int n FROM crm.decision GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
const decSystem = decByTenant.find((r) => r.tenant_id === 'system')?.n || 0;
const decAll = decByTenant.reduce((s, r) => s + r.n, 0);

// ── 7. 近 7 天新增质量（修复是否真的生效）───────────────────────────────────
const fresh = await q(`SELECT count(*)::int n,
    count(*) FILTER (WHERE tenant_id <> 'system')::int biz,
    count(*) FILTER (WHERE entity_id IS NOT NULL)::int anchored,
    count(*) FILTER (WHERE payload ? 'summary')::int projected
  FROM crm.memory_log WHERE created_at > now() - interval '7 days'`).then((r) => r[0]);

const metrics = {
  总量: total,
  业务租户记忆占比: pct(bizRows, total),
  锚点覆盖率: pct(anchored, bizActive),
  决策投影完整率: pct(decSummary, decTotal),
  噪声占比: pct(noise, total),
  近24h新增噪声: noise24h,
  可注入命中率: pct(injectable, total),
  决策落system占比: pct(decSystem, decAll),
  近7天: { 新增: fresh.n, 归属业务租户: fresh.biz, 带锚点: fresh.anchored, 含投影: fresh.projected },
  tenant_top: byTenant.slice(0, 8),
};

// ── 缺口判定（gap_type 供闭环复用；同一 (gap_type) 复发计数在 feedback 侧累加）──
const TH = { 业务租户记忆占比: 30, 锚点覆盖率: 60, 决策投影完整率: 80, 可注入命中率: 50, 噪声占比: 20 };
const gaps = [];
const gap = (type, detail) => gaps.push({ type, detail });
if (metrics.业务租户记忆占比 < TH.业务租户记忆占比) gap('tenant-writeback', `业务租户记忆仅 ${metrics.业务租户记忆占比}%（阈值 ${TH.业务租户记忆占比}%）；写侧未落 tenant_id`);
if (metrics.锚点覆盖率 < TH.锚点覆盖率) gap('entity-anchor', `业务记忆锚点覆盖 ${metrics.锚点覆盖率}%（阈值 ${TH.锚点覆盖率}%）；客户聚合仍会空`);
if (metrics.决策投影完整率 < TH.决策投影完整率) gap('decision-projection', `决策记忆含 summary 仅 ${metrics.决策投影完整率}%（C7 投影未覆盖/存量未重放）`);
if (metrics.可注入命中率 < TH.可注入命中率) gap('inject-empty', `可注入记忆仅 ${metrics.可注入命中率}%；injector.memoryText 会过滤成空串（写到读双向落空）`);
if (metrics.噪声占比 > TH.噪声占比) gap('noise-flood', `噪声占比 ${metrics.噪声占比}%（阈值 ${TH.噪声占比}%）；capture 白名单未生效或存量未归档`);
if (noise24h > 0) gap('noise-live', `近 24h 仍新增 ${noise24h} 条 trace 噪声——源头未切断（先修 capture 再谈修补）`);
if (metrics.决策落system占比 > 80 && decAll > 20) gap('decision-tenant', `决策落 system 占 ${metrics.决策落system占比}%：mint 路径未传 tenantId（C5）`);

const report = { at: new Date().toISOString(), db: process.env.PGDATABASE, metrics, gaps, healthy: gaps.length === 0 };

console.log('\n===== 记忆系统健康巡检 =====');
console.log(`时间 ${report.at} | 库 ${report.db} | 总记忆 ${total} 条\n`);
for (const [k, v] of Object.entries(metrics)) {
  if (k === 'tenant_top') continue;
  console.log(`  ${k.padEnd(16, '　')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}
console.log('\n  租户分布 top8:');
for (const r of metrics.tenant_top) console.log(`    ${String(r.tenant_id).padEnd(18)} ${r.n}`);
console.log(`\n  缺口 ${gaps.length} 项：`);
if (!gaps.length) console.log('    （无）');
for (const g of gaps) console.log(`    [${g.type}] ${g.detail}`);

const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx > -1 && process.argv[jsonIdx + 1]) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(report, null, 2));
  console.log(`\nJSON 已写入 ${process.argv[jsonIdx + 1]}`);
}
if (process.argv.includes('--fail-on-gap') && gaps.length) process.exitCode = 2;
await db.end();
