// src/alerts/tokenAccounting.js — Token-业务因果对账（09 §5-V6）
// 设计输入：docs/superpowers/plans/2026-08-26-ai-10-gap-repair-plan.md Task G4-T1 + 09-ai-feedback-loop §5-V6
// 纪律：
//   - token_accounting = append-only（无 updated_at 列，禁 update/delete），与 audit_event 同纪律
//   - recordTokens：token 计量采集（写 Action 执行处挂；未提供 token 则 0 占位，不伪造）
//   - reconcileTokenToBusiness：烧 token vs 业务产出二元组（业务产出 = 该 actor 该时段
//     audit_event 的「写 Action executed」成功数 + 审计事件总数——与 G1 audit_event 联动）
import { query, queryWrite } from '../db.js';
import { bumpModuleUsage } from '../billing/subscriptionService.js';

export async function ensureTokenSchema() {
  // ⚠ 2026-09-04 修复：建表必须含 tenant_id（recordTokens 写入该列；fail-open 下缺列会静默失败→计量恒为 0）。
  // CREATE IF NOT EXISTS 对既有表不补列，故额外 ADD COLUMN IF NOT EXISTS 兜底（幂等、安全）。
  await queryWrite(`CREATE TABLE IF NOT EXISTS crm.token_accounting (
    id BIGSERIAL PRIMARY KEY,
    actor TEXT NOT NULL DEFAULT 'system',      -- 执行者（人/Agent）→ 对账分组键
    action TEXT NOT NULL,                       -- 触发动作（crm-deal-advance…）
    tokens_in INT NOT NULL DEFAULT 0,           -- 输入 token（LLM 请求；无则 0）
    tokens_out INT NOT NULL DEFAULT 0,          -- 输出 token（LLM 响应；无则 0）
    source TEXT NOT NULL DEFAULT 'llm',         -- 计量来源（llm/evaluator/rule…）
    decision_id UUID,                           -- 关联决策（写第0闸同源）
    tenant_id TEXT NOT NULL DEFAULT 'system',   -- 租户维度（按租户统计 LLM Token 用量的必需维度）
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await queryWrite(`ALTER TABLE crm.token_accounting ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_crm_token_accounting_actor ON crm.token_accounting(actor, created_at)`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_crm_token_accounting_tenant ON crm.token_accounting(tenant_id, created_at)`);
}

// token 计量采集（append-only）：写 Action 执行成功处调用；token 值未提供 → 0（不伪造计量）
// module：模块归因维度（缺省 core）；归因写 module_usage 失败不阻断 token 主计量（fail-open）
export async function recordTokens({ actor = 'system', action = 'unknown', tokensIn = 0, tokensOut = 0, source = 'llm', decision_id = null, tenantId = 'system', module = 'core' } = {}) {
  try {
    await queryWrite(
      `INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, source, decision_id, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor, action, Number(tokensIn) || 0, Number(tokensOut) || 0, source, decision_id, tenantId]
    );
    // 模块归因（fail-open：失败不阻断 token 主计量）
    await bumpModuleUsage(tenantId, module, { calls: 1, tokensIn: Number(tokensIn) || 0, tokensOut: Number(tokensOut) || 0 }).catch(() => {});
    return { ok: true };
  } catch (e) {
    // 计量失败不阻断主写（fail-open；对齐 auditHook「审计失败不阻断主事务」）
    return { ok: false, error: e.message };
  }
}

// 对账：烧 token vs 业务产出（二元组，非报表式静态）
// 业务产出 = 该 actor 该时段的：
//   · productivity：audit_event 中 action 以 ':executed' 结尾的写 Action 成功数（真实落库产出）
//   · audit_events：该 actor 全部审计事件数（含失败/请求——过程可观测性维度）
// since：ISO 时间字符串（缺省回退 24h）；返回窗口期便于复跑
export async function reconcileTokenToBusiness({ actor = null, since = null } = {}) {
  const sinceTs = since || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const actorWhere = actor ? 'AND actor=$2' : '';
  const actorParam = actor ? [sinceTs, actor] : [sinceTs];

  const [tok, prod, allAudit] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(tokens_in),0)::int AS tin, COALESCE(SUM(tokens_out),0)::int AS tout
       FROM crm.token_accounting WHERE created_at >= $1 ${actorWhere}`,
      actorParam
    ),
    query(
      `SELECT count(*)::int AS n FROM crm.audit_event
       WHERE created_at >= $1 AND action LIKE '%:executed' ${actorWhere}`,
      actorParam
    ),
    query(
      `SELECT count(*)::int AS n FROM crm.audit_event WHERE created_at >= $1 ${actorWhere}`,
      actorParam
    ),
  ]);

  const t = tok.rows[0];
  return {
    since: sinceTs,
    actor: actor || '*',
    tokens: { in: t.tin, out: t.tout, total: t.tin + t.tout },
    business: { productivity: prod.rows[0].n, audit_events: allAudit.rows[0].n },
  };
}