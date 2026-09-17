// src/action/channelActions.js — 需求② 通道的 MCP 暴露面（WorkBuddy 对话入口先行，§4.5.2-A / §4.6.1）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §4.5.2-A（对话内向导）+ §4.6.1（A 随时问 / ③日期驱动建日历）
//
// 为什么走 Action Registry 而不是另建 handler 清单：
//   MCP 工具面（buildMcpTools）**唯一来源＝Action Registry**（namespace/kind/lifecycle 决定暴露）。
//   历史上「MCP 零暴露」的根因正是「页面/模块做了但没注册成 Action」——故通道能力必须注册成 Action，
//   由 buildMcpTools 咽喉统一暴露，一处注册覆盖 server.js / 校验脚本 / 探针。
//
// 口径（与 crm-signal-list / crm-signal-ics 同源）：
//   · kind='read' → 读直连，不触写闸；kind='write' → gateway 两阶段 + 决策第 0 闸；
//   · 身份 fail-closed：缺 ctx.actor 一律拒绝（**不返回全量**——不收窄＝全租户泄漏，是最危险的假绿方向）；
//   · 接入＝四类动作 first-connect → 过 review-gate（HITL 人工闸）；凭据入 credentialVault，明文不回显；
//   · ICS **复用 `src/signal/ics.js` buildIcs**（单一实现，禁再造第二套 VEVENT 渲染）。
import { registerAction } from './registry.js';
import { buildIcs } from '../signal/ics.js';
import { isChannelKind } from '../channels/kinds.js';

const PROVIDER_KEY = 'integration-providers';

// 可注入 deps（测试注入替身；缺省走真实实现）——无参调用行为与真实实现一致。
export function buildChannelActions(deps = {}) {
  const loadCfg = deps.readConfig || (async (key, opt) => {
    const m = await import('../config/configStore.js');
    return m.readConfig(key, opt);
  });
  const saveCfg = deps.writeConfig || (async (key, value, opt) => {
    const m = await import('../config/configStore.js');
    return m.writeConfig(key, value, opt);
  });
  const saveSecret = deps.persistSecret || (async (a) => {
    const m = await import('../connectors/discovery/credentialVault.js');
    return m.persistSecret(a);
  });
  const fetchIncremental = deps.fetchIncremental || null; // 缺省无（读需真实通道接入＝P4）

  const requireActor = (ctx) => (ctx?.actor ? null : { ok: false, error: 'auth_required', hint: 'MCP 通道需要已登录身份（先 crm_login）' });

  return [
    {
      name: 'crm-channel-connect', kind: 'write', permission: 'auth',
      namespace: 'crm', agentTool: true, needsApproval: true, force: false,
      version: '1.0.0', owner: 'crm-native', confirm: 'stage1',
      decisionScenario: 'config-change',
      description: '接入邮箱/日历/会议/微信通道（一次向导：收凭据 → verifyScope 真探测 → 过 review-gate 入库）；首次默认 L1 只读',
      schema: { kind: 'string', credentials: 'object', label: 'string', id: 'string' },
      parameters: { required: ['kind'], properties: { kind: { type: 'string' }, credentials: { type: 'object' } } },
      handler: async (args = {}, ctx = {}) => {
        const bad = requireActor(ctx); if (bad) return bad;
        // ⚠ kind 判据单一源：禁 startsWith('generic-')（generic-rest/mcp/cli 不是通道）
        if (!isChannelKind(args.kind)) return { ok: false, error: 'kind_invalid', hint: 'kind 须为 generic-email/calendar/meeting/wechat' };
        const tenantId = ctx.tenantId || 'system';
        const id = args.id || `channel-${String(args.kind).replace('generic-', '')}-${tenantId}`;
        // ① 凭据入 vault（明文不落响应/审计）
        if (args.credentials && typeof args.credentials === 'object' && Object.keys(args.credentials).length) {
          await saveSecret({ tenantId, providerId: id, raw: args.credentials })
            .catch((e) => { throw new Error(`credential_store_failed: ${e?.code || e?.message || e}`); });
        } else {
          return { ok: false, error: 'credentials_missing', hint: '该通道需补齐凭据（credentials_missing），明文不入库不回显' };
        }
        // ② verifyScope 真探测（fail-closed；不 mock 代真）
        const verifyScope = deps.verifyScope || null;
        if (verifyScope) {
          const v = await verifyScope({ tenantId, id, kind: args.kind }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          if (!v?.ok) return { ok: false, error: v?.error || 'verify_failed', probe: v?.probe || null, hint: v?.hint || '该通道需补齐凭据' };
        }
        // ③ 接入＝first-connect → 过 review-gate（HITL 人工闸）
        const reviewGate = deps.reviewGate || null;
        if (reviewGate && typeof reviewGate.hasApproval === 'function') {
          const a = await reviewGate.hasApproval({ action: 'first-connect', tenantId, ctx: { id, kind: args.kind } }).catch(() => null);
          if (!a) return { ok: false, error: 'approval_required', hint: '接入需人工闸放行（HITL）' };
        }
        const row = await loadCfg(PROVIDER_KEY, { tenantId }).catch(() => null);
        const list = Array.isArray(row?.value) ? row.value : [];
        const idx = list.findIndex((d) => d.id === id);
        const desc = { id, kind: args.kind, label: args.label || args.kind, enabled: true, trust_level: 'L1', objects: [] };
        if (idx >= 0) list[idx] = desc; else list.push(desc);
        await saveCfg(PROVIDER_KEY, list, { tenantId, decisionId: ctx.decision_id || null, updatedBy: ctx.actor || 'mcp' });
        return {
          ok: true, stored: true, channel: { id, kind: args.kind, enabled: true, trust_level: 'L1' },
          hint: '首次只读（L1），信任提升过独立闸门',
        };
      },
    },

    {
      name: 'crm-channel-query', kind: 'read', permission: 'auth',
      namespace: 'crm', agentTool: true, needsApproval: false,
      version: '1.0.0', owner: 'crm-native',
      description: '读通道近 N 天事件摘要（Ask, and it\'s there；只读抽取结构化字段，不落正文）',
      schema: { days: 'number', object: 'string' },
      handler: async (args = {}, ctx = {}) => {
        const bad = requireActor(ctx); if (bad) return bad;
        const tenantId = ctx.tenantId || 'system';
        const days = Math.max(1, Number(args.days) || 30);
        const read = fetchIncremental || deps.fetchIncremental;
        if (typeof read !== 'function') {
          // 未接通（P4 未交付）→ **如实报**，不假装读到 0 条（「零命中」与「没接线」必须可区分）
          return { ok: false, error: 'channel_not_connected', hint: '通道读取未接通（P4）——未接入不得宣称已接入' };
        }
        const r = await read({ tenantId, object: args.object || 'email', sinceDays: days })
          .catch((e) => ({ ok: false, error: String(e?.message || e) }));
        if (!r?.ok) return { ok: false, error: r?.error || 'read_failed', hint: '通道未接入或无凭据（L1 只读）' };
        const items = (r.rows || []).slice(0, 10).map((ev) => ({
          channel: ev.channel, kind: ev.kind, ts: ev.ts, domain: ev.domain,
          subject: ev.content?.subject || null,
        }));
        return { ok: true, tenant_id: tenantId, days, total: (r.rows || []).length, items };
      },
    },

    {
      name: 'crm-channel-ics-export', kind: 'read', permission: 'auth',
      namespace: 'crm', agentTool: true, needsApproval: false,
      version: '1.0.0', owner: 'crm-native',
      description: '把带日期语义的通道事件导出为标准 iCalendar（.ics）文本；无日期/非法日期明确失败（不造幽灵日程）',
      schema: { events: 'array' },
      handler: async (args = {}, ctx = {}) => {
        const bad = requireActor(ctx); if (bad) return bad;
        const events = Array.isArray(args.events) ? args.events : [];
        const blocks = [];
        let skipped = 0;
        for (const e of events) {
          // 映射到 buildIcs 的信号形状（复用单一实现；缺日期 → null → 跳过，不造幽灵日程）
          const ics = buildIcs({
            signal_id: e.external_id || e.id || 'channel-event',
            kind: e.kind || 'channel',
            payload: { event_at: e.dtstart || e.ts || null, subject: e.summary || e.subject || null, body: e.desc || null },
          });
          if (!ics) { skipped++; continue; }
          // 只取 VEVENT 块并入本日历（buildIcs 返回完整 VCALENDAR）
          blocks.push(ics.split('\r\n').slice(5, -2).join('\r\n'));
        }
        const lines = [
          'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ChiYu Enterprise AI Sales//Channel//CN',
          'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
          ...blocks,
          'END:VCALENDAR',
        ];
        return {
          ok: true, filename: 'chiyuai-channel.ics', content_type: 'text/calendar',
          ics: lines.join('\r\n') + '\r\n', exported: blocks.length, skipped,
        };
      },
    },
  ];
}

// 注册进 Action Registry（MCP 工具面唯一来源）。可在测试中注入替身 deps。
export function seedChannelActions(deps = {}) {
  for (const a of buildChannelActions(deps)) registerAction(a);
}
