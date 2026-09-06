-- db/fix-2026-08-27-dirty-deal.sql — 一次性数据修复（幂等）
-- Problem: CRM_DEAL 存在 ① leak 脏 stage（leads 非六段）② state 误写业务 stage ③ 重复 slug
-- 依据：docs/2026-08-27-system-diag-report.md §3/§6 + 实施计划 Task 0

-- ① 非法 stage 归位：leads → lead（合规六段：lead/opportunity/quoted/contracted/ordered/paid）
UPDATE crm.particles SET payload = jsonb_set(payload, '{stage}', '"lead"')
WHERE type='CRM_DEAL' AND payload->>'stage'='leads';

-- ② state 归位：state 只允许粒子生命周期（ACTIVE），误写业务 stage 的改回 ACTIVE
UPDATE crm.particles SET state='ACTIVE'
WHERE type='CRM_DEAL' AND state IN ('lead','quoted','contracted','paid','opportunity','ordered','leads');

-- ③ 重复 slug：保留每 slug 最新一条，其余改 slug 加短 id 后缀（不删除，保留数据）
UPDATE crm.particles p SET slug = p.slug || '-' || substr(p.id::text, 1, 8)
WHERE type='CRM_DEAL' AND id NOT IN (
  SELECT DISTINCT ON (slug) id FROM crm.particles
  WHERE type='CRM_DEAL' ORDER BY slug, created_at DESC
);