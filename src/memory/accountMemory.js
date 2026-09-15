// src/memory/accountMemory.js
// C3: 账户持久记忆（append-only + 30 天蒸馏）。吸收 Clay Account Agent 持久记忆范式，
// 但守「禁 DELETE」：只 append，绝不删历史；30 天后蒸馏为 curated note（memory_log 仍保留）。
//
// ⚠ 本模块**不发明新契约**（消解 #3）：全部复用既有记忆层真实函数——
//   写：memoryLog.appendMemory({topic,kind,payload,entityId,entityType,tenantId})
//   读：memoryLog.retrieveMemory({layer,topic,tenantId})
//   蒸馏筛选：memoryLog.classifyForDistill(rows,{ttlDays,now})（纯函数）
//   写 note：note.upsertNote({layer,topic,content,ttlDays})（返回 memory_note 行，键为 content）
// 生产默认走真实模块；测试注入替身（DI，零 PG）——与 createXxxRouter 的 deps 范式一致。
import { appendMemory as realAppendMemory, retrieveMemory as realRetrieveMemory, classifyForDistill } from './memoryLog.js';
import { upsertNote as realUpsertNote } from './note.js';

// 默认 store（生产真实契约）；测试注入替身即可完全离线
const DEFAULT_STORE = { appendMemory: realAppendMemory, retrieveMemory: realRetrieveMemory, upsertNote: realUpsertNote };

export const DISTILL_AFTER_DAYS = 30;
const ACCOUNT_LAYER = 'L-Workspace';

/** topic 规约：account:<id>（跨商机累积的账户维度记忆；与事件流 topic `event:*` 并列不冲突）。 */
export function accountTopic(accountId) {
  return `account:${accountId}`;
}

/**
 * 增量 append 账户记忆（append-only）。
 * @returns appendMemory 原始结果 { ok, row, tenant_id, entity_id, entity_type }
 */
export async function appendAccountMemory(accountId, entry = {}, { store = DEFAULT_STORE, tenantId = null } = {}) {
  const { kind = 'event', payload = {}, ...rest } = entry || {};
  return store.appendMemory({
    topic: accountTopic(accountId),
    kind,
    payload,
    layer: ACCOUNT_LAYER,
    entityId: String(accountId),
    entityType: 'ACCOUNT',
    tenantId,
    ...rest,
  });
}

/**
 * 30 天蒸馏：把账户 memory_log 中过期行聚合成一条 curated note（memory_log 行保持不动）。
 * @returns note 行（含 content）｜null（无过期历史时不产空 note）
 */
export async function distillAccountMemory(accountId, { store = DEFAULT_STORE, now = Date.now(), ttlDays = DISTILL_AFTER_DAYS } = {}) {
  const { rows = [] } = (await store.retrieveMemory({
    layer: ACCOUNT_LAYER, topic: accountTopic(accountId), limit: 200,
  })) || {};
  // 复用真实纯函数做时间筛选（不发明 before 参数）
  const older = classifyForDistill(rows, { ttlDays, now: new Date(now) }).filter((r) => r._markDistilled);
  if (!older.length) return null;
  // payload.why_narrative 优先（glass-box 叙事），退回 kind
  const summary = older.map((e) => e.payload?.why_narrative || e.kind).filter(Boolean).join('; ');
  return store.upsertNote({
    layer: ACCOUNT_LAYER,
    topic: `${accountTopic(accountId)}:curated`,
    content: summary,
    ttlDays: 365,
  });
}
