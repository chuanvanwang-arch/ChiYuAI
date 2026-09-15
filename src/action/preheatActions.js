// src/action/preheatActions.js — P1-3 触达前预热工作流（DEAL payload.preheat 子状态机 + HITL）
// 设计输入：docs/2026-09-15-anysite-borrowing-analysis.md §4.3
// 铁律：
//   ① HITL——无人工确认（hitl_confirm）不产生任何对外动作；AI 仅排期与提醒
//   ② 不改 stage 状态机——本子状态机活在 DEAL payload.preheat 内（payload 子状态）
//   ③ 纯函数状态转移（无 IO，单测友好）；写操作由 Action 层经第 0 闸落库
export const PREHEAT_STATES = Object.freeze(['waiting', 'scheduled', 'engaged', 'ready']);

const EVENTS = Object.freeze({
  waiting:   { schedule: 'scheduled' },
  scheduled: { engage: 'engaged' },   // engage 需 hitl_confirm:true 参数（HITL 闸）
  engaged:   { ready: 'ready' },
});

// 状态转移纯函数：非法转移抛错；engage 无 HITL 确认抛错（fail-closed）
export function preheatTransition(state, event, payload = {}) {
  if (event === 'engage' && !payload.hitl_confirm) {
    throw new Error('preheat: engage 需 HITL 人工确认（hitl_confirm:true），AI 不得自动对外互动');
  }
  const next = EVENTS[state]?.[event];
  if (!next) throw new Error(`preheat: 非法转移 ${state} --${event}--> ~`);
  return next;
}

// 纯函数：按信号新鲜度排序互动序列（联动 P0-1 时间衰减）。
//   signal_ts 存在（fresh）→ due=asap（优先排前）；无 ts → due=next_cycle。
//   step 编号即执行顺序（1..n），供 preheat-schedule Action 落 payload.preheat.plan
export function buildPreheatPlan(candidates, { signal_fresh_map = null } = {}) {
  // 排序后再重新编号 step（step=执行顺序 1..n；等价类内保序稳定）
  return candidates
    .map((c) => ({ ...c, due: c.signal_ts ? 'asap' : 'next_cycle' }))
    .sort((a, b) => {
      // fresh 优先：asap（有 ts）排前；同为 asap 则按 ts 新→旧；否则保序
      if (a.due !== b.due) return a.due === 'asap' ? -1 : 1;
      if (a.signal_ts && b.signal_ts) return b.signal_ts - a.signal_ts;
      return 0;
    })
    .map((c, i) => ({ ...c, step: i + 1 }));
}

// —— P1-3 Actions（seed-actions.js 装配 3/3：import + 调用 seedPreheatActions）——
import { registerAction } from './registry.js';
import { emit } from '../events/bus.js';

export function seedPreheatActions() {
  // preheat-schedule（只读）：基于最新信号产出预热排期计划（落 payload.preheat.plan 由调用方/前端落库）
  //   铁律：AI 仅排期与提醒，不产生对外动作（对外互动仅 humans engage 后）
  registerAction({
    name: 'preheat-schedule', kind: 'read', permission: 'auth',
    namespace: 'preheat', agentTool: true, force: false, needsApproval: false,
    autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
    schema: { deal_id: 'string', candidates: 'array' },
    parameters: { required: ['deal_id'] },
    handler: async ({ deal_id, candidates = [] }, ctx, deps = {}) => {
      const plan = buildPreheatPlan(candidates);
      // 只读排期：返回计划供人工审阅（不落库、不对外）——HITL：确认后才由 preheat-mark 触发落库
      return { deal_id, state: 'scheduled', plan, hitl_note: '排期仅建议，engage 需人工确认（hitl_confirm）' };
    },
  });

  // preheat-mark（唯一写）：标记 engage/ready（写经第 0 闸 + HITL token）
  //   engage 必须 hitl_confirm:true（否则 fail-closed 拒出）；写 DEAL payload.preheat.state
  registerAction({
    name: 'preheat-mark', kind: 'write', permission: 'auth',
    namespace: 'preheat', agentTool: true, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'prospecting', version: '1.0.0',
    decisionScenario: 'PREHEAT_MARK',
    schema: { deal_id: 'string', event: 'string', hitl_confirm: 'boolean' },
    parameters: { required: ['deal_id', 'event'] },
    handler: async ({ deal_id, event, hitl_confirm = false }, ctx, deps = {}) => {
      // 状态转移（含 HITL 闸：engage 无 hitl_confirm 抛错）
      if (!event || !['schedule', 'engage', 'ready'].includes(event)) {
        throw new Error(`preheat: 非法事件 ${event}（须 schedule/engage/ready）`);
      }
      const updateParticle = deps.updateParticle || (await import('../particles/particleRepo.js')).updateParticle;
      const getParticle = deps.getParticle || (await import('../particles/particleRepo.js')).getParticle;
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      const cur = deal.payload?.preheat?.state || 'waiting';
      const next = preheatTransition(cur, event, { hitl_confirm });   // 抛错即 fail-closed
      const emit_ = deps.emit || emit;
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload,
          preheat: {
            ...(deal.payload?.preheat || {}),
            state: next,
            [`${event}_at`]: new Date().toISOString(),
            hitl_confirm: event === 'engage' ? !!hitl_confirm : undefined,
          },
        },
        requireDecisionId: ctx.decision_id,   // 第 0 闸：无决策不写
        tenantId: ctx.tenantId,
      });
      emit_('crm', 'preheat-mark', { deal_id, event, from: cur, to: next, tenant_id: ctx.tenantId });
      return { ...updated, preheat_state: next };
    },
  });

  // preheat-status（只读）：查询当前预热状态
  registerAction({
    name: 'preheat-status', kind: 'read', permission: 'auth',
    namespace: 'preheat', agentTool: true, force: false, needsApproval: false,
    autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
    schema: { deal_id: 'string' },
    parameters: { required: ['deal_id'] },
    handler: async ({ deal_id }, ctx, deps = {}) => {
      const getParticle = deps.getParticle || (await import('../particles/particleRepo.js')).getParticle;
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      return {
        deal_id,
        state: deal.payload?.preheat?.state || 'waiting',
        plan: deal.payload?.preheat?.plan || [],
        history: {
          schedule_at: deal.payload?.preheat?.schedule_at || null,
          engage_at: deal.payload?.preheat?.engage_at || null,
          ready_at: deal.payload?.preheat?.ready_at || null,
        },
      };
    },
  });
}
