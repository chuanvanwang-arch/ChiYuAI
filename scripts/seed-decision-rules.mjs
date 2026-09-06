// scripts/seed-decision-rules.mjs — P-1 T2 验收前置：生产库灌入启用规则（decision_rule 种子）
//
// 设计依据：docs/2026-09-02-cognitive-decision-unified-design.md §11.1 T2
//   「造 1 条启用的 decision_rule → S4 返回边界条目，governance 维 supplied=true」
//   「S4 规则校验 0 hit（动作名错配）；内置/DB 规则 match 仅认 action==='advance'」
//   生产库 crm.decision_rule 2026-09-02 实测 0 行 → S4 装配恒 empty → governance 维恒 false。
//
// 种子内容（与 ruleEngine.js BUILTIN 同构，但落 DB 由 loadRulesFromDb 消费）：
//   1) stage_forward_only  CRM_DEAL.advance  阶段只进不退（write-gate 护栏，S4 供给治理边界）
//   2) lost_requires_reason CRM_DEAL.advance  输单必填原因
//   3) quote_approval_needed CRM_DEAL.quote   报价折扣超权限需审批（CRM_APPROVAL_FLOW 治理红线）
//
// 幂等：ON CONFLICT (code) DO UPDATE（不 DELETE、不重复插入）。
// 用法：node scripts/seed-decision-rules.mjs   （默认 PGDATABASE=crm_native 生产库）
// 护栏：显式设置 PGDATABASE，禁止 --dry-run 之外任何参数默认连测试库（默认=生产=设计文档验收目标）。

process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';

const { pool } = await import('../src/db.js');

const RULES = [
  {
    code: 'stage_forward_only',
    match_type: 'CRM_DEAL.advance',
    match_payload: {},
    check_payload: { op: 'stage_forward', flow: { lead: 0, opportunity: 1, quoted: 2, contracted: 3, ordered: 4, paid: 5, lost: 6, disqualified: 7 } },
    enabled: true,
  },
  {
    code: 'lost_requires_reason',
    match_type: 'CRM_DEAL.advance',
    match_payload: {},
    check_payload: { op: 'requires_reason' },
    enabled: true,
  },
  {
    code: 'quote_approval_needed',
    match_type: 'CRM_DEAL.quote',
    match_payload: {},
    check_payload: { op: 'approval_required', approval_flow: 'CRM_APPROVAL_FLOW' },
    enabled: true,
  },
];

let inserted = 0;
let updated = 0;
for (const r of RULES) {
  const res = await pool.query(
    `INSERT INTO crm.decision_rule (code, match_type, match_payload, check_payload, enabled)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)
     ON CONFLICT (code) DO UPDATE SET
       match_type=EXCLUDED.match_type, match_payload=EXCLUDED.match_payload,
       check_payload=EXCLUDED.check_payload, enabled=EXCLUDED.enabled
     RETURNING (xmax = 0) AS inserted`,
    [r.code, r.match_type, JSON.stringify(r.match_payload), JSON.stringify(r.check_payload), r.enabled]
  );
  if (res.rows[0]?.inserted) inserted += 1;
  else updated += 1;
}

const { rows } = await pool.query(
  `SELECT code, match_type, enabled FROM crm.decision_rule ORDER BY code`
);
console.log(`[seed-decision-rules] inserted=${inserted} updated=${updated} total=${rows.length}`);
for (const r of rows) console.log(`  ${r.enabled ? 'ENABLED' : 'disabled'} ${r.code} (${r.match_type})`);

await pool.end();