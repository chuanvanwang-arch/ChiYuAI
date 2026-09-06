-- db/migrations/2026-09-03-tenant-isolation.sql
-- 多行业配置化元模型：元模型层(meta_attr) + 记忆层(memory_log/snapshot/note) 补 tenant_id 维度；edges 补 cardinality。
-- 这是「按租户全隔离数据权限 + 客户记忆全隔离」的结构性 20%（设计 §15）。
-- 幂等：所有 ADD COLUMN 用 IF NOT EXISTS；索引用 IF NOT EXISTS。

ALTER TABLE crm.meta_attr ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE crm.memory_snapshot ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE crm.memory_note ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE crm.edges ADD COLUMN IF NOT EXISTS cardinality TEXT NOT NULL DEFAULT 'many'
  CHECK (cardinality IN ('one','many'));

CREATE INDEX IF NOT EXISTS idx_crm_meta_attr_tenant ON crm.meta_attr(tenant_id, particle_type);
CREATE INDEX IF NOT EXISTS idx_crm_memory_log_tenant ON crm.memory_log(tenant_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_crm_memory_snapshot_tenant ON crm.memory_snapshot(tenant_id, ref_id);
CREATE INDEX IF NOT EXISTS idx_crm_memory_note_tenant ON crm.memory_note(tenant_id, topic);
CREATE INDEX IF NOT EXISTS idx_crm_edges_cardinality ON crm.edges(tenant_id, edge_type);
