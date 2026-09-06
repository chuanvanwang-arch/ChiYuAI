CREATE TABLE IF NOT EXISTS crm.agent_contract_feedback (
  id               BIGSERIAL PRIMARY KEY,
  contract_task_id text NOT NULL,
  agent           text,
  gap_type        text NOT NULL,
  observed        text,
  expected        text,
  severity        text DEFAULT 'medium',
  ts              timestamptz DEFAULT now(),
  resolved        bool DEFAULT false,
  UNIQUE (contract_task_id, gap_type)
);
