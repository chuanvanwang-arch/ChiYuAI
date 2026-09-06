// src/ruleEngine.js — 规则层（AI 写操作护栏「能不能写」）—— G2 规则 DB 化
// 实证（§5ter.3）：商机阶段只进不退 / 输单必填原因 / 合同金额超 20% 审批
// G2 迁移（dev-plan Task 2）：规则由 crm.decision_rule 表驱动（DB 权威），rule_hit 落库留痕 100%。
//   loadRulesFromDb() 读表 → 内存缓存；check() 逐条 evaluate，block 落 rule_hit(blocked=true)。
//   DB 空/不可用时回退硬编码种子（parity 保守：不回退就是静默不拦，反而危险）。
import { query, queryWrite } from './db.js';

// 硬编码种子（仅在 DB 未加载时兜底；迁移测试断言 DB 化后 DB 规则生效）
const BUILTIN_RULES = [
  {
    code: 'stage_forward_only',
    match: (type, action, patch) => type === 'CRM_DEAL' && action === 'advance',
    check: (type, action, patch) => {
      const flow = { lead: 0, opportunity: 1, quoted: 2, contracted: 3, ordered: 4, paid: 5, lost: 6, disqualified: 7 };
      if (patch.from == null || patch.to == null) return { ok: true };
      return { ok: (flow[patch.to] || 0) >= (flow[patch.from] || 0),
               reasons: (flow[patch.to] || 0) >= (flow[patch.from] || 0) ? [] : ['stage_forward_only'] };
    },
  },
  {
    code: 'lost_requires_reason',
    match: (type, action, patch) => type === 'CRM_DEAL' && action === 'advance' && (patch?.to === 'lost' || patch?.to === 'disqualified'),
    check: (type, action, patch) => {
      const missing = !patch?.transitionedBecause && !patch?.closed_reason;
      return { ok: !missing, reasons: missing ? ['lost_requires_reason'] : [] };
    },
  },
];

// ── G2 DB 缓存（内存镜像；loadRulesFromDb 后生效；reset 清缓存回退种子）──
let dbRules = null; // null = 未加载（回退种子）；[] = 已加载但无规则（DB 权威：无规则不拦）

export function resetRuleCache() {
  dbRules = null;
}

// 读 crm.decision_rule（仅 enabled=true），把 match_type 'TYPE.action' 编译为 match 函数
// 规则行结构：code / match_type('CRM_DEAL.advance') / match_payload / check_payload / enabled
export async function loadRulesFromDb({ q = query } = {}) {
  const r = await q(`SELECT code, match_type, match_payload, check_payload, enabled
                     FROM crm.decision_rule WHERE enabled=true ORDER BY code`);
  dbRules = (r.rows || []).map((row) => {
    const [type, action] = (row.match_type || '').split('.');
    const cp = row.check_payload || {};
    return {
      code: row.code,
      match: (t, a) => t === type && a === action,
      check: (t, a, patch) => {
        // check_payload 语义（对齐种子规则，DB 化后由表承载）：
        //   { op:'stage_forward', flow:{lead:0,opportunity:1,...} } → 阶段只进不退
        //   { op:'requires_reason' }                                  → 输单必填原因
        //   默认（无 op）→ 命中即拦：DB 权威 = 表内启用规则即护栏清单（空参数不自行放行，
        //     避免"已配置却不生效"的静默漂移；规则行本身已表达拦截意图）
        if (cp.op === 'stage_forward') {
          const flow = cp.flow || {};
          if (patch.from == null || patch.to == null) return { ok: true, reasons: [] };
          const ok = (flow[patch.to] ?? 0) >= (flow[patch.from] ?? 0);
          return { ok, reasons: ok ? [] : [row.code] };
        }
        if (cp.op === 'requires_reason') {
          const missing = !patch?.transitionedBecause && !patch?.closed_reason;
          return { ok: !missing, reasons: missing ? [row.code] : [] };
        }
        // 无 op 的护栏规则：命中即拦（放行需显式 op:'pass'）
        return { ok: false, reasons: [row.code] };
      },
    };
  });
  return dbRules;
}

// 追加规则（第0闸后调用；仅写 DB，缓存由调用方 loadRulesFromDb 刷新）
export async function addDbRule({ code, match_type, match_payload = {}, check_payload = {}, enabled = true, decision_id = null }) {
  const r = await queryWrite(
    `INSERT INTO crm.decision_rule (code, match_type, match_payload, check_payload, enabled, decision_id)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO UPDATE SET
       match_type=EXCLUDED.match_type, match_payload=EXCLUDED.match_payload,
       check_payload=EXCLUDED.check_payload, enabled=EXCLUDED.enabled, decision_id=EXCLUDED.decision_id
     RETURNING *`,
    [code, match_type, JSON.stringify(match_payload), JSON.stringify(check_payload), enabled, decision_id]
  );
  return r.rows[0];
}

// rule_hit 留痕（block/命中都落；测试断言 block 落库率 100%）
async function recordHit({ ruleCode, decisionId = null, blocked, reasons = [] }) {
  try {
    await queryWrite(
      `INSERT INTO crm.rule_hit (rule_code, decision_id, blocked, reasons)
       VALUES ($1,$2,$3,$4)`,
      [ruleCode, decisionId, blocked, JSON.stringify(reasons)]
    );
  } catch (e) {
    // 留痕失败不阻断写闸（G3 可观测：ruleEngine 热路径零阻塞）
    console.error('[ruleEngine] recordHit failed:', e?.message);
  }
}

// 只读评估（供 S4 供给侧"治理边界"使用）：返回适用规则与评估结果，不落 rule_hit（避免与写闸重复留痕）。
// 与 check() 的区别：check() 逐条 recordHit（写闸热路径留痕）；此处仅供给信号，零副作用。
export function evaluateRules(type, action, patch) {
  const rules = (dbRules === null ? BUILTIN_RULES : dbRules);
  const applied = [];
  for (const rule of rules) {
    if (!rule.match(type, action, patch)) continue;
    const r = rule.check(type, action, patch);
    applied.push({ code: rule.code, ok: !!r.ok, reasons: r.reasons || [] });
  }
  return { applied, ok: applied.every((a) => a.ok) };
}

export const ruleEngine = {
  // check：DB 规则优先；DB 未加载( null )回退种子；DB 已加载但空 → 无规则不拦（尊重 DB 权威）
  async check(type, action, patch, ctx) {
    const rules = (dbRules === null ? BUILTIN_RULES : dbRules);
    const blocked = [];
    for (const rule of rules) {
      if (!rule.match(type, action, patch)) continue;
      const r = rule.check(type, action, patch, ctx);
      if (!r.ok) {
        blocked.push(...(r.reasons || [`rule:${rule.code}`]));
        await recordHit({ ruleCode: rule.code, decisionId: ctx?.decision_id, blocked: true, reasons: r.reasons });
      } else {
        await recordHit({ ruleCode: rule.code, decisionId: ctx?.decision_id, blocked: false });
      }
    }
    return { ok: blocked.length === 0, reasons: blocked };
  },
};