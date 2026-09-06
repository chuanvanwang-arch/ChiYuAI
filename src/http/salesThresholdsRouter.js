// src/http/salesThresholdsRouter.js — 判定阈值配置后台化（config_store['sales-thresholds']）
// 原则（用户 2026-08-30）：业务阈值不得硬编码在 SKILL 或代码里，客户须能按需调整。
// 契约：
//   GET /api/config/sales-thresholds → mergedThresholds(readCurrent())（任意登录用户可读）
//   PUT /api/config/sales-thresholds → 局部更新（范围校验 + 决策第0闸凭证 + sysadmin/admin 闸）
// 消费方：src/sales/salesThresholds.js（读取层）→ behaviorChecklist / evaluator / executor / namedAccountBoard
// 设计：docs/2026-08-30-sales-thresholds-config-design.md §2
import { Router } from 'express';
import { scenarioDeps } from '../portal/decisionScenario.js';
import { resolveMe as realResolveMe } from './auth.js';
import { readConfig, writeConfig } from '../config/configStore.js';
import { scopeTenant, scopeOf } from './tenantScope.js';
import { DEFAULT_THRESHOLDS, mergedThresholds } from '../sales/salesThresholds.js';

const CONFIG_KEY = 'sales-thresholds';

function roleOk(role) { return role === 'admin' || role === 'sysadmin' || role === 'ten_admin'; }

// 范围校验规则：越界一律 400，防止误配成极端值（如 pass=0 导致全量达标）
const RULES = {
  'bantcc.pass': { min: 0, max: 1, type: 'number', label: 'BANTCC 达标线（0~1）' },
  'bantcc.unknown': { min: 0, max: 1, type: 'number', label: 'BANTCC 未知兜底值（0~1）' },
  'behavior.min_customer_types': { min: 1, max: 10, type: 'int', label: '客户类型种数下限' },
  'behavior.min_contacts': { min: 1, max: 20, type: 'int', label: '联系人数量下限' },
  'behavior.recent_visit_days': { min: 1, max: 365, type: 'int', label: '近期拜访天数窗口' },
  // 客户覆盖频度与拜访数量（外部 SKILL 建议值出厂，客户可调）
  'coverage.target_month_days': { min: 1, max: 365, type: 'int', label: '目标客户月覆盖频度（天）' },
  'coverage.potential_quarter_days': { min: 1, max: 1095, type: 'int', label: '潜力客户季覆盖频度（天）' },
  'coverage.lost_contact_days': { min: 1, max: 1095, type: 'int', label: '失联流失警戒线（天）' },
  'coverage.daily_visits_target': { min: 0, max: 20, type: 'int', label: '日均拜访数量目标' },
  'coverage.weekly_visits_target': { min: 0, max: 100, type: 'int', label: '每周拜访数量目标' },
  'coverage.daily_visits_optimized': { min: 0, max: 20, type: 'int', label: '日均拜访数量优化目标' },
  'coverage.info_collect_weekly': { min: 1, max: 100, type: 'int', label: '周信息收集进度（客户数）' },
  'coverage.customer_count_min': { min: 1, max: 10000, type: 'int', label: '客户数量合理下限' },
  'coverage.customer_count_target': { min: 1, max: 10000, type: 'int', label: '客户数量定额' },
  'coverage.named_visit_warn_days': { min: 0, max: 365, type: 'int', label: '指名应访黄色提醒天数(须<红色)' },
  'coverage.named_visit_alert_days': { min: 1, max: 365, type: 'int', label: '指名应访红色告警天数' },
  'rhythm.adherence_window_days': { min: 1, max: 365, type: 'int', label: '拜访频率达标窗口天数' },
  'stage.stuck_days': { min: 1, max: 365, type: 'int', label: '阶段停留告警天数' },
  'gate.s1_s2_min_need_facts': { min: 1, max: 3, type: 'int', label: 'S1→S2 需求事实项数' },
  'ui.behavior_pass_rate_ok': { min: 0, max: 100, type: 'int', label: '21 条合格率着色阈值(%)' },
  'taoran.achieved_ratio': { min: 0, max: 100, type: 'int', label: 'TAORAN 达标比例(%)' },
  'taoran.unachieved_ratio': { min: 0, max: 100, type: 'int', label: 'TAORAN 未达分数档(%)' },
  // 漏斗质量（P1-B）：加权值/抖动/承诺带一律客户可配
  'funnel.weighted.win': { min: 0, max: 1, type: 'number', label: '加权值-确保' },
  'funnel.weighted.adv': { min: 0, max: 1, type: 'number', label: '加权值-优势' },
  'funnel.weighted.even': { min: 0, max: 1, type: 'number', label: '加权值-可能+' },
  'funnel.weighted.weak': { min: 0, max: 1, type: 'number', label: '加权值-可能-' },
  'funnel.jitter_max': { min: 0, max: 1, type: 'number', label: '抖动率健康阈值(≤)' },
  'funnel.health_min_ratio': { min: 0, max: 2, type: 'number', label: '漏斗健康线（销售潜力达成率≥）' },
  'funnel.month_new_bid_ratio': { min: 0, max: 1, type: 'number', label: '月新增开标占比健康阈值(≤)' },
  'funnel.commit.green_low': { min: 0, max: 1, type: 'number', label: '承诺兑现绿带下限' },
  'funnel.commit.green_high': { min: 0, max: 2, type: 'number', label: '承诺兑现绿带上限' },
  'funnel.commit.yellow_low': { min: 0, max: 1, type: 'number', label: '承诺兑现黄带下限' },
  'funnel.commit.purple_low': { min: 0, max: 2, type: 'number', label: '承诺兑现紫带下限(≥)' },
  'funnel.annual_target': { min: 0, max: 1e12, type: 'number', label: '年任务金额(健康性分母)' },
  'funnel.forecast_breach_ratio': { min: 0, max: 2, type: 'number', label: '预测缺口阈值(销售潜力)' },
  // SWAS 商机回顾（P1-A）：回顾新鲜度 + P2→P3 soft 闸阈值
  'swas.stale_days': { min: 1, max: 365, type: 'int', label: 'SWAS 回顾新鲜度天数(>此值标 stuck)' },
  'swas.soft_warn_below': { min: 0, max: 1, type: 'number', label: 'S2→S3 SWAS 齐全度 soft 闸下限' },
  // 漏斗转化率 KPI（设计 §4：监控/辅导层，非门禁；健康线客户可配）
  'funnelKpi.s1_s2': { min: 0, max: 1, type: 'number', label: '漏斗转化率 S1→S2 健康线(≥)' },
  'funnelKpi.s2_s3': { min: 0, max: 1, type: 'number', label: '漏斗转化率 S2→S3 健康线(≥)' },
  'funnelKpi.s3_s4': { min: 0, max: 1, type: 'number', label: '漏斗转化率 S3→S4 健康线(≥)' },
  'funnelKpi.s4_s5': { min: 0, max: 1, type: 'number', label: '漏斗转化率 S4→S5 健康线(≥)' },
};

function getPath(obj, path) {
  return String(path || '').split('.').filter(Boolean)
    .reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}
function setPath(obj, path, val) {
  const keys = String(path).split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = val;
}

async function readCurrent(tenantId) {
  try {
    const r = await readConfig(CONFIG_KEY, { tenantId });
    return r?.value || {};
  } catch { return {}; }
}

export function createSalesThresholdsRouter() {
  const router = Router();

  router.get('/api/config/sales-thresholds', async (req, res) => {
    try {
      let me;
      try { me = await realResolveMe(req); } catch { me = { ok: false }; }
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      res.json({ ...mergedThresholds(await readCurrent(scopeTenant(me))), rules: RULES });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/api/config/sales-thresholds', async (req, res) => {
    try {
      let me;
      try { me = await realResolveMe(req); } catch { me = { ok: false }; }
      if (!me?.ok || !roleOk(me.role)) { res.status(403).json({ error: '需要 sysadmin 权限' }); return; }

      // 只接受已知点路径；未知的键一律拒绝（防注入任意配置）
      const changed = [];
      const cur = mergedThresholds(await readCurrent());
      for (const path of Object.keys(RULES)) {
        const v = getPath(req.body || {}, path);
        if (v === undefined || v === null) continue;
        const rule = RULES[path];
        const n = Number(v);
        if (!Number.isFinite(n)) return res.status(400).json({ error: `${rule.label} 须为数字` });
        if (rule.type === 'int' && !Number.isInteger(n)) return res.status(400).json({ error: `${rule.label} 须为整数` });
        if (n < rule.min || n > rule.max) return res.status(400).json({ error: `${rule.label} 须在 ${rule.min}~${rule.max} 之间` });
        if (getPath(cur, path) !== n) { setPath(cur, path, n); changed.push(path); }
      }
      if (!changed.length) return res.status(400).json({ error: '无可更新字段（或值未变化）' });

      const decision = await scenarioDeps.produceDecision({ scenario_id: 'config_change', fields: changed });
      await writeConfig(CONFIG_KEY, cur, { tenantId: scopeOf(me), decisionId: decision?.decisionId || null, updatedBy: 'system' });
      res.json({ ...cur, changed, decision: decision?.decisionId || null, updated: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}

export { DEFAULT_THRESHOLDS, CONFIG_KEY, RULES };
