-- C2 决策完整性：审计链哈希代次 + 巡检封印（2026-09-03）
-- 设计：docs/superpowers/plans/2026-09-03-c2c3c4-decision-integrity-implementation.md T1/T2
-- 幂等：可重复执行（ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS）

-- ── T1：哈希代次列 ────────────────────────────────────────────────
-- v1 = 历史行（仅哈希 payload）；v2 = 白名单版（身份+语义+墓碑字段一并入哈希）。
-- verifyChain 按行分派算法 → 算法升级后历史行仍可被检出篡改，不因升级而全量失效。
ALTER TABLE crm.decision_provenance ADD COLUMN IF NOT EXISTS hash_version INT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_crm_decision_provenance_hv ON crm.decision_provenance(hash_version);

-- ── T2：巡检封印快照 ───────────────────────────────────────────────
-- 哈希链固有盲区：删除「链尾」因无后继引用其 previous_checksum 而不可检出。
-- 巡检时记录 (head_checksum, entry_count)，下次比对：
--   entry_count 减少        → HEAD_LOST（链尾被删）
--   count 不变但 head 变更  → TAMPERED（就地篡改）
CREATE TABLE IF NOT EXISTS crm.provenance_seal (
  decision_id    UUID PRIMARY KEY,
  head_checksum  TEXT,
  entry_count    INT NOT NULL DEFAULT 0,
  sealed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status    TEXT
);
