-- 幂等补列：修复 agentEpisodes 因缺列静默失败（设计 §1.1）
ALTER TABLE crm.monitor_event ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE crm.monitor_event ADD COLUMN IF NOT EXISTS context_facts jsonb;
CREATE INDEX IF NOT EXISTS idx_crm_monitor_event_agent
  ON crm.monitor_event(agent_id, created_at);
