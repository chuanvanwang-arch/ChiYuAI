-- migrate-knowledge-kind-backfill.sql
-- 目的：回填 CRM_KNOWLEDGE 粒子缺失的 payload.kind 字段（用户 2026-09-10 裁决：先补齐存量 65 条）。
-- 背景：D11 探针实测 65 条中仅 12 条种子数据有 kind（icp/competitors/objections/buyer_language），
--        其余 53 条缺 kind。诊断确认 53 条呈两种确定性形态，按 payload 形态二分类回填，无需猜测：
--          · 形态A 词表术语（含 type+layer 且无 content）→ kind='vocabulary'（系统词表，LK 已自动排除）
--          · 形态B 商机阶段跃迁叙事（含 content）→ kind='transition'
-- 性质：非破坏性（jsonb_set 仅新增字段）、幂等（仅改 kind 为空者）、可逆（置回 NULL 即还原）。
-- 不触碰已有 12 条销售知识（kind 已在四类内，WHERE 条件天然排除）。

-- 形态A：系统词表术语 → vocabulary
UPDATE crm.particles
SET payload = jsonb_set(payload, '{kind}', '"vocabulary"')
WHERE type = 'CRM_KNOWLEDGE'
  AND (payload->>'kind' IS NULL OR payload->>'kind' = '')
  AND payload ? 'type' AND payload ? 'layer'
  AND NOT (payload ? 'content');

-- 形态B：商机阶段跃迁叙事（含 content）→ transition
UPDATE crm.particles
SET payload = jsonb_set(payload, '{kind}', '"transition"')
WHERE type = 'CRM_KNOWLEDGE'
  AND (payload->>'kind' IS NULL OR payload->>'kind' = '')
  AND payload ? 'content';

-- 断言：不应有残留 null kind（若形态分类有遗漏，下面这行会返回 >0，需人工介入）
-- SELECT count(*) FROM crm.particles WHERE type='CRM_KNOWLEDGE' AND (payload->>'kind' IS NULL OR payload->>'kind'='');
