-- ============================================================================
-- crm.signal 补「处置血缘」三列（2026-09-16）
-- 设计：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.3
-- 审计：docs/2026-09-16-design-merge-audit.md §6.1（DDL 漂移）+ §10 第 6 项
--
-- 为什么必须补（不是"锦上添花"）：
--   三处生产调用点早已在传这些字段，而 store.setStatus 的 extra 形参从未被读：
--     src/signal/adoption.js:11  setStatus(...,'acted', { action_ref, decision_id })
--     src/signal/adoption.js:23  setStatus(...,'closed', { rejected_by, reason })
--     src/http/routes.js:390     setStatus(...,'closed', { reason })
--   → 字段被静默丢弃，且**测试不可见**（test/signal/adoption.test.js 注入的是假 store）。
--   后果：采纳回路无法回答"哪个决策批准的 / 采纳后触发了哪个 Action"；关闭信号无关闭原因。
--
-- 幂等：ADD COLUMN IF NOT EXISTS，可重复执行。
-- 只做加列，不改索引、不改既有列，对既有行无影响（新列默认 NULL）。
-- ⚠ 建表单一事实源仍是 db/schema.sql（新库直接含新列）；本文件仅供既有库补齐。
-- ============================================================================

ALTER TABLE crm.signal ADD COLUMN IF NOT EXISTS decision_id   TEXT NULL;
ALTER TABLE crm.signal ADD COLUMN IF NOT EXISTS action_ref    TEXT NULL;
ALTER TABLE crm.signal ADD COLUMN IF NOT EXISTS closed_reason TEXT NULL;

-- 复核（期望 3 行）：
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='crm' AND table_name='signal'
--      AND column_name IN ('decision_id','action_ref','closed_reason');
