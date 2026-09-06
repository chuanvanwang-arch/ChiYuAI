// src/decision/retroTrigger.js —— 事件触发式复盘（③）
// 设计：docs/2026-09-01-event-triggered-retro-design.md（方案 A：事件总线订阅）
// 计划：docs/superpowers/plans/2026-09-01-event-triggered-retro-plan.md
//
// 链路：confirmDecision → emit('decision','confirmed') → 本订阅器
//        → 回查 business_tier / tenant_id → 分级闸 + 冷却闸
//        → createTask({intent:'retro'}) → routeThroughIntake 路由到 decision-retro
//
// 铁律遵循：
//  1. 阈值全配置化 —— min_tier / cooldown_hours 走 config_store['event-retro']，代码只存出厂默认；
//  2. fail-open —— 配置读失败用默认值，订阅器内异常一律吞掉并打日志，绝不阻断 confirmDecision 写路径；
//  3. 零 schema 迁移 —— 不新增列/表；decision.tenant_id 属迁移列（db/migrate-tenant.js:14），旧库缺列时降级为 'system'；
//  4. 禁删 —— 只 INSERT 任务，绝不删除既有复盘任务。
import { on } from '../events/bus.js';
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { createTask } from '../kanban/kanban.js';

// 出厂默认（唯一事实源为 config_store['event-retro']，此处仅兜底）
export const DEFAULT_EVENT_RETRO_CFG = Object.freeze({
  enabled: true,          // 总开关
  min_tier: 'HIGH',       // 触发下限分级（NORMAL/LEAD < HIGH < CRITICAL）
  cooldown_hours: 24,     // 同租户复盘任务冷却窗（小时）
  auto_pump: true,        // 建单后是否立即泵一次 ready 队列
});

// 分级排序：LEAD 与 NORMAL 同权（intake 无 level 列，统一用 business_tier）
const TIER_RANK = Object.freeze({ NORMAL: 0, LEAD: 0, HIGH: 1, CRITICAL: 2 });

function rankOf(tier) {
  const k = String(tier || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(TIER_RANK, k) ? TIER_RANK[k] : 0;
}

// 读配置（fail-open：任何异常返回出厂默认，不阻断链路）
// 租户化（T5，P1）：内部处理器显式传租户；缺省 'system' 保持既有行为（回读平台默认），向后兼容
export async function readEventRetroConfig({ tenantId = 'system' } = {}) {
  try {
    const c = await readConfig('event-retro', { tenantId });
    return { ...DEFAULT_EVENT_RETRO_CFG, ...(c?.value || {}) };
  } catch {
    return { ...DEFAULT_EVENT_RETRO_CFG };
  }
}

// 回查决策元数据：emit payload 只有 {decision_id, by_role}，tier/tenant 必须回查
// 容旧库：tenant_id 是 migrate-tenant.js 追加列，缺列时退化查询并落 'system'
export async function loadDecisionMeta(decisionId) {
  try {
    const r = await query(
      'SELECT business_tier, tenant_id FROM crm.decision WHERE decision_id=$1',
      [decisionId]
    );
    const d = r.rows[0];
    return d ? { tier: d.business_tier, tenantId: d.tenant_id || 'system' } : null;
  } catch {
    const r = await query(
      'SELECT business_tier FROM crm.decision WHERE decision_id=$1',
      [decisionId]
    );
    const d = r.rows[0];
    return d ? { tier: d.business_tier, tenantId: 'system' } : null;
  }
}

// 冷却闸：同租户在窗口内已有复盘任务（含人工触发的）则跳过，防复盘刷单
export async function hasRecentRetroTask(tenantId, cooldownHours) {
  const r = await query(
    `SELECT id FROM crm.tasks
      WHERE tenant_id=$1
        AND payload->>'intent'='retro'
        AND created_at >= now() - make_interval(hours => $2::int)
      LIMIT 1`,
    [tenantId, cooldownHours]
  );
  return r.rows.length > 0;
}

// 分级闸
export function tierPasses(tier, cfg) {
  return rankOf(tier) >= rankOf(cfg?.min_tier);
}

// 核心判定 + 建单（可独立调用，便于测试与手工补触发）
// 返回 { created:boolean, reason?:string, task?, tier?, tenantId? }
export async function maybeTriggerRetro(decisionId) {
  if (!decisionId) return { created: false, reason: 'no_decision_id' };

  // 租户化（T5，P1）：先回查决策租户，再按租户读配置（对齐设计 §2.3 id 35「配置读按决策租户」）
  //   顺序调整：readEventRetroConfig 需 tenantId → loadDecisionMeta 先执行；
  //   decision_not_found 从「配置读后」提前到「配置读前」——语义等价（同为 fail-open 返回 reason）
  const meta = await loadDecisionMeta(decisionId);
  if (!meta) return { created: false, reason: 'decision_not_found' };
  const cfg = await readEventRetroConfig({ tenantId: meta.tenantId });
  if (!cfg.enabled) return { created: false, reason: 'disabled' };
  if (!tierPasses(meta.tier, cfg)) {
    return { created: false, reason: `tier_below_min:${meta.tier}` };
  }
  if (await hasRecentRetroTask(meta.tenantId, cfg.cooldown_hours)) {
    return { created: false, reason: 'cooldown' };
  }

  const short = String(decisionId).slice(0, 8);
  const task = await createTask({
    tenantId: meta.tenantId,
    step: 'retro',
    title: `重大决策复盘（${meta.tier}）· 决策 ${short}`,
    actionName: 'decision-retrospective',
    payload: {
      intent: 'retro',          // scheduler.routeThroughIntake → targetAgent='decision-retro'
      level: 'L2',              // L2 → gateAgents=[]，复盘任务不再触发评审闸
      decision_id: decisionId,
      business_tier: meta.tier,
      triggered_by: 'event',
      source: 'decision:confirmed',
    },
    decisionId,
  });

  // 立即泵一次，避免等到下一个调度周期（失败不影响建单结果）
  if (cfg.auto_pump) {
    try {
      const { pumpReadyTasks } = await import('../kanban/scheduler.js');
      await pumpReadyTasks({ tenantId: meta.tenantId });
    } catch (e) {
      console.error('[retro-trigger] pump 失败:', e?.message);
    }
  }

  return { created: true, task, tier: meta.tier, tenantId: meta.tenantId };
}

let unsub = null;

// 挂载订阅（幂等：重复调用返回同一 unsub）
export function registerRetroTrigger() {
  if (unsub) return unsub;
  unsub = on('decision', (msg) => {
    if (msg?.type !== 'confirmed') return;
    const decisionId = msg?.summary?.decision_id;
    if (!decisionId) return;
    // 异步脱钩：绝不阻塞 confirmDecision 的写事务返回
    void (async () => {
      try {
        const r = await maybeTriggerRetro(decisionId);
        if (r.created) {
          console.log(
            `[retro-trigger] 已建复盘任务 decision=${String(decisionId).slice(0, 8)} tier=${r.tier} tenant=${r.tenantId}`
          );
        }
      } catch (e) {
        console.error('[retro-trigger] 处理 decision:confirmed 异常:', e?.message);
      }
    })();
  });
  return unsub;
}

export function unregisterRetroTrigger() {
  if (unsub) {
    unsub();
    unsub = null;
  }
}
