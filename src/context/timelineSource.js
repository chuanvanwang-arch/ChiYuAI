// src/context/timelineSource.js — 叙事时间线（J7 决策七轴之 WHEN 轴）单一事实源
//
// 职责边界（决策问责统一设计 §4 / J7 三系统收口 §3）：
//   - 时间线是「派生视图」，不是存储资产：四源（events/tasks/decision/memory_log）只读聚合，不落库。
//   - 时间基准统一为 BG-08 单一事实源 DECISION_TIME_BASIS（COALESCE(decided_at, created_at)），
//     杜绝「同一条决策在决策列表按 decided_at 排、在时间线按 created_at 排」的基准漂移。
import { query as defaultQuery } from '../db.js';

// BG-08：决策发生时间的唯一权威表达式。所有需要「决策何时发生」的排序/展示一律引用此常量，
// 不得再各自写 decided_at 或 created_at（漂移即为回归）。
export const DECISION_TIME_BASIS = 'COALESCE(decided_at, created_at)';

export const TIMELINE_SOURCE_LIMIT = 100; // 每源取数上限（防宽表爆炸）

// 纯函数：多源事件 → 统一时间线条目，按 ts 倒序 + 同秒同实体去重
// 由 src/account/insightService.js re-export（routes.js 既有 import 保持不变）
export function buildTimelineRows(sources) {
  const seen = new Set();
  const rows = [];
  for (const ev of sources || []) {
    const key = `${ev.ts}|${ev.type}|${ev.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      ts: ev.ts, type: ev.type, title: ev.title, source: ev.source,
      actor: ev.actor, entity: ev.entityType, summary: ev.summary,
    });
  }
  return rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

// 纯函数：倒序行 → 正序（最早→最近）。叙事时间线注入 LLM 时用正序，符合「故事」阅读顺序。
export function chronological(rows) {
  return [...(rows || [])].reverse();
}

// 纯函数：为时间线行生成可读标题（四源回退，杜绝空标题列）
function fallbackTitle(r) {
  if (r.title) return r.title;
  const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
  switch (r.type) {
    case 'event': {
      // 生产 crm.events 的 payload 无 title 键，真实可读信息在 **行级** type 列与 payload.entity_type
      // （如 type=ontology-sync / entity_type=CRM_ACCOUNT）。合成「类型 · 实体类型」兜底，
      // 避免整列退化为无信息量的「事件」二字。
      const parts = [r.event_type || p.event_type, r.entity_type || p.entity_type].filter(Boolean);
      return p.title || p.name || p.action || parts.join(' · ') || '事件';
    }
    case 'task': return r.title || r.action_name || r.task || p.title || '任务';
    case 'decision': return r.scenario_id || r.title || '决策';
    case 'memory': return p.title || r.topic || r.kind || r.event_type || '记忆';
    default: return r.title || p.title || r.topic || '记录';
  }
}

// 纯函数：执行者兜底。四源中 events.actor 与 decision.decider_role 在生产均存在 NULL 行
// （上海印通客户时间线曾 5 行执行者列全空），统一归口到「系统」而非留空单元格。
function fallbackActor(r) {
  if (r.actor) return r.actor;
  const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
  return p.actor || p.decider_role || '系统';
}

const normRow = (r) => ({
  ts: r.occurred_at?.toISOString?.() || String(r.occurred_at ?? ''),
  type: r.type,
  title: fallbackTitle(r),
  source: r.source || '',
  actor: fallbackActor(r),
  entityType: r.entity_type || '',
  entityId: r.entity_id || '',
  summary: r.summary || '',
});

// 薄封装：时间线四源抽取（events / tasks / decision / memory_log），只读
// 无实体作用域（accountId/dealIds 皆空）时返回 []，不抛错、不降级——叙事是可选增强而非必需层
export async function retrieveTimeline({ accountId = null, dealIds = [], limit = TIMELINE_SOURCE_LIMIT, tenantId = 'system', query = defaultQuery } = {}) {
  if (!accountId && !(Array.isArray(dealIds) && dealIds.length)) return [];
  const acc = accountId || '';
  const deals = Array.isArray(dealIds) ? dealIds : [];
  const lim = Number(limit) > 0 ? Number(limit) : TIMELINE_SOURCE_LIMIT;

  const [ev, tk, dc, ml] = await Promise.all([
    query(
      // A3（2026-09-02）：锚点键由 account_id 改为 entity_id，对齐 A1 recordEvent 的写入形态
      //   （recordEvent 写 payload.entity_id）。原查 payload->>'account_id' 与新写入形态不匹配，
      //   即便 events 有数据也抽不到。entity_id 同时兼容客户与商机锚点，故用 =ANY(deals) 双匹配。
      // 2026-09-03：补 SELECT `type AS event_type` —— 生产 payload 无 title 键，
      //   fallbackTitle 的 event_type 分支此前因该列未取出而永远落空，标题列整列显示「事件」。
      // 2026-09-03：生产 crm.events 的 payload 无 source 键（实测 125 行 / 命中 0 行）
      //   → 时间线「来源」列整列空白。COALESCE 兜底为可读来源名，杜绝恒空列。
      `SELECT 'event' AS type, payload->>'title' AS title, actor, created_at AS occurred_at,
              COALESCE(NULLIF(payload->>'source',''), '事件总线') AS source,
              payload->>'entity_type' AS entity_type,
              type AS event_type,
              id::text AS entity_id, '' AS summary
       FROM crm.events
       WHERE payload->>'entity_id'=$1 OR payload->>'entity_id'=ANY($2::text[])
       ORDER BY created_at DESC LIMIT $3`,
      [acc, deals, lim]
    ).catch(() => ({ rows: [] })),
    query(
      // A3：tasks 源双形态兼容（既有写入方用 account_id，新通道用 entity_id），避免任一形态落空
      `SELECT 'task' AS type, title, 'system' AS actor, created_at AS occurred_at,
              'AI' AS source, action_name AS entity_type, id::text AS entity_id, '' AS summary
       FROM crm.tasks
       WHERE payload->>'account_id'=$1 OR payload->>'entity_id'=$1
          OR payload->>'entity_id'=ANY($2::text[])
       ORDER BY created_at DESC LIMIT $3`,
      [acc, deals, lim]
    ).catch(() => ({ rows: [] })),
    query(
      // BG-08：决策时间基准统一（与 retrieveL2 排序同源），不再用裸 created_at
      // 缝修复 2026-09-02：involved_entities 实际以**数组**形态存储
      // （[{"id":"a1111111-...","type":"CRM_ACCOUNT"}]），原 ` @> '{"account_id":..}'::jsonb`
      // 对数组恒 false → 决策源永远抽不到任何行 → 故事线恒空。
      // 改为双形态匹配：对象形态（含 account_id 键）∪ 数组形态（元素 id 命中）。
      // jsonb_typeof 守卫防止该列为 {}（对象）时 jsonb_array_elements 抛错。
      `SELECT 'decision' AS type, scenario_id AS title, decider_role AS actor,
              ${DECISION_TIME_BASIS} AS occurred_at,
              '决策' AS source, 'DECISION' AS entity_type, decision_id::text AS entity_id,
              '' AS summary
       FROM crm.decision
       WHERE involved_entities @> $1::jsonb
          OR (jsonb_typeof(involved_entities) = 'array'
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(involved_entities) e
                          -- 2026-09-03：销售决策通常只关联 CRM_DEAL，未挂 CRM_ACCOUNT，
                          --   仅按 accountId 匹配 → 时间线决策源恒空（与 insightService.loadDecisions 同源缺口）
                          WHERE e->>'id' = $3 OR e->>'id' = ANY($4::text[])))
       ORDER BY ${DECISION_TIME_BASIS} DESC LIMIT $2`,
      [JSON.stringify({ account_id: acc }), lim, acc, deals]
    ).catch(() => ({ rows: [] })),
    query(
      // A3（2026-09-02）：锚点由 topic 字符串前缀改为 memory_log.entity_id 列（A2 新增）。
      //   原 `topic='account:<id>'` 与生产数据形态（event:* / decision:*）不符 → 记忆源恒空。
      //   ⚠️ 注意两处 entity_id 语义不同，不可混淆：
      //     SELECT 的 `id::text AS entity_id`  = 记录自身 id，供 buildTimelineRows 做**去重键**
      //     WHERE  的 `m.entity_id`             = 客户锚点列，供**按客户过滤**
      //   若把客户 id 当去重键，同客户同秒的多条记忆会被吞成一条（反假绿护栏用例已覆盖）。
      // 2026-09-03：补 SELECT `topic` —— 生产 memory_log 无 title，topic（如 event:trace:*）
      //   是唯一可读标识，此前未取出 → 标题列整列显示「记忆」。
      `SELECT 'memory' AS type, payload->>'title' AS title, 'system' AS actor, created_at AS occurred_at,
              '记忆' AS source, kind AS entity_type, id::text AS entity_id, '' AS summary,
              m.topic AS topic
       FROM crm.memory_log m
       -- 2026-09-03 多行业配置化(P1)：记忆源按租户隔离，杜绝跨租户客户记忆串扰
       WHERE (m.entity_id=$1 OR m.entity_id=ANY($2::text[])) AND m.tenant_id=$4
       ORDER BY created_at DESC LIMIT $3`,
      [acc, deals, lim, tenantId]
    ).catch(() => ({ rows: [] })),
  ]);
  // A3（2026-09-02）：四源拼接后**必须全局排序**——原先只拼接不排序，返回的是
  //   「先 events、再 tasks、再 decision、再 memory」的分组序列，跨源时间顺序是乱的。
  //   契约不一致导致：assembler.js:103 记得补 buildTimelineRows，insightService.js:237 直接用返回值
  //   → 账户洞察页的故事线时序错乱。现把排序内聚到本函数，所有调用方拿到即有序。
  //   buildTimelineRows 幂等，assembler 的二次调用无副作用。
  return buildTimelineRows([...ev.rows, ...tk.rows, ...dc.rows, ...ml.rows].map(normRow));
}

// 纯函数：单行 → 时间线文本（供注入层渲染 WHEN 轴）
export function formatTimelineRow(r) {
  const t = String(r?.ts || '').slice(0, 16).replace('T', ' ');
  const who = r?.actor ? `${r.actor}` : '—';
  const what = r?.title || r?.entity || '事件';
  return `${t} ${r?.source || r?.type || '事件'}｜${who}｜${what}`;
}
