#!/usr/bin/env node
// scripts/dedup-backfill.mjs — 存量账户疑似重复扫描与归并（高置信自动，低置信出清单）
// 设计：docs/plans/2026-09-07-crm-dedup.md 任务4
// 用法：node scripts/dedup-backfill.mjs [--dry] [TENANT]
//   --dry：只扫描出报告，不实际归并（先跑 --dry 审阅再正式执行）
//   TENANT：可选，默认 'system'（传具体租户 id 则只查该租户）
import { query, queryWrite } from '../src/db.js';
import { mergeTwoAccounts } from '../src/particles/dedup.js';
import { normalizeAccountName } from '../src/sales/accountGuard.js';

// 纯对比较（不查库）：两侧归一化名称精确相等（同行业或一方无行业）→ 高置信归并
//   —— 计划原稿用 detectAccountDuplicateDeep(name) 查全局库，会命中“第三方/自身”引发链式错配，
//   且两侧各自查库互为候选恒真。存量批处理只应比较两行本身，杜绝跨名/第三方误并。
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0));
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    dp[i][0] = i;
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}
function pairVerdict(a, b) {
  const na = normalizeAccountName(a.payload?.name || ''), nb = normalizeAccountName(b.payload?.name || '');
  if (!na || !nb) return { decision: 'SKIP' };
  const industryMatch = !a.payload?.industry || !b.payload?.industry || a.payload?.industry === b.payload?.industry;
  if (na === nb && industryMatch) return { decision: 'MERGE', reason: 'exact_name+industry' };
  const sim = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  if (sim >= 0.9 && industryMatch) return { decision: 'MERGE', reason: 'fuzzy_high+industry' };
  if (sim >= 0.6) return { decision: 'PROMPT', similarity: Number(sim.toFixed(3)) };
  return { decision: 'CREATE' };
}

// 2026-09-08 修复：原 `process.argv[2]` 会把 `--dry` 本身当成租户名
//   （`node dedup-backfill.mjs --dry` → tenant_id='--dry' → 查 0 行 → 报告全空「假绿」）。
//   租户只认 TENANT 环境变量或**非 --flag 的位置实参**。
const DRY = process.argv.includes('--dry');
const POSITIONAL = process.argv.slice(2).filter((s) => !String(s).startsWith('--'));
const TENANT = process.env.TENANT || POSITIONAL[0] || 'system';

const accounts = (await query(
  `SELECT id, payload, meta FROM crm.particles
   WHERE tenant_id=$1 AND type='CRM_ACCOUNT' AND (meta->>'merged_into') IS NULL`,
  [TENANT]
)).rows;

const report = { tenant: TENANT, dry: DRY, autoMerged: [], lowConfidence: [], errors: [] };
for (let i = 0; i < accounts.length; i++) {
  for (let j = i + 1; j < accounts.length; j++) {
    const a = accounts[i], b = accounts[j];
    try {
      const v = pairVerdict(a, b);
      if (v.decision === 'MERGE') {
        if (DRY) { report.autoMerged.push({ primary: a.id, secondary: b.id, reason: v.reason, dry: true }); continue; }
        const res = await mergeTwoAccounts(a.id, b.id, TENANT);
        report.autoMerged.push({ ...res, reason: v.reason });
      } else if (v.decision === 'PROMPT') {
        report.lowConfidence.push({ a: a.id, b: b.id, similarity: v.similarity });
      }
    } catch (e) {
      report.errors.push({ a: a.id, b: b.id, error: e.message });
    }
  }
}
console.log(JSON.stringify(report, null, 2));
if (!DRY) {
  await queryWrite(`INSERT INTO crm.dedup_audit (tenant_id, report) VALUES ($1,$2)`,
    [TENANT, JSON.stringify(report)]).catch(() => {});
}
