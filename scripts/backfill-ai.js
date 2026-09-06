// scripts/backfill-ai.js — 存量粒子补 AI 属性（payload.ai 回填；幂等可重跑）
// 根因：db/seed.sql 直接 SQL INSERT 绕过 createParticle，存量粒子缺 payload.ai；
//       particle-detail.html 前端只统计 payload.ai.*，导致 AI 徽章恒为 0。
// 运行：node scripts/backfill-ai.js   （依赖真实 PG；新创建粒子已由 createParticle 自动补）
//       node scripts/backfill-ai.js --dry     （仅统计，不落库）
//       node scripts/backfill-ai.js --no-llm  （强制确定性兜底，忽略后台 LLM 配置）
// 2026-08-28：默认自动按 config_store('llm') 解析（未配置 → 整轮确定性兜底，与原行为一致）
import { runRiskScan } from '../src/scheduler/riskScanner.js';

async function main() {
  const dryRun = process.argv.includes('--dry');
  const forceRule = process.argv.includes('--no-llm');
  // runRiskScan 全量重算 CRM_DEAL/CRM_ACCOUNT/CRM_CONTACT 的 AI 属性
  const r = await runRiskScan(forceRule ? { llm: null, dryRun } : { dryRun });
  console.log(`[backfill-ai] scanned=${r.scanned} changed=${r.changed} degraded=${r.degraded} llm_enabled=${r.llm_enabled} llm_calls=${r.llm_calls}${dryRun ? ' (dryRun)' : ''}`);
  if (!dryRun && r.changed > 0) {
    console.log('[backfill-ai] 已为存量粒子补 payload.ai，刷新粒子详情页即可见 AI 计数');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('[backfill-ai] failed:', e); process.exit(1); });
