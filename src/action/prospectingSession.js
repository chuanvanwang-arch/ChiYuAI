// src/action/prospectingSession.js — 拓客会话状态机（内存，不落粒子，红线 §10）
// 设计输入：docs/2026-09-14-prospecting-module-design.md §1.1/§1.3
// 5 态：searching → listing → selecting → pending_confirm → pooled
// 非法转移抛错（纯函数，零 IO，单测友好）；超时 30 分钟自动失效；
// 并发隔离（同租户同 actor 仅一活跃会话，新建覆盖旧会话）；容量上限 100（保留最近）
const SESSIONS = new Map();       // sessionId -> session
const ACTIVE = new Map();         // `${tenantId}:${actor}` -> sessionId
const TTL_MS = 30 * 60 * 1000;    // 30 分钟
const MAX_SESSIONS = 100;
let seq = 0;                      // 同毫秒防碰撞：sessionId 唯一性兜底

const TRANSITIONS = {
  searching:       ['list_ready'],
  listing:         ['select', 'search_again'],
  selecting:       ['confirm_ready', 'search_again'],
  pending_confirm: ['confirm'],
  pooled:          [],
};

// 纯函数状态转移：非法事件抛错（不允许的转移视为编程/协议错误，显式 fail-fast）
export function transition(state, event) {
  const next = {
    searching:       { list_ready: 'listing' },
    listing:         { select: 'selecting', search_again: 'searching' },
    selecting:       { confirm_ready: 'pending_confirm', search_again: 'searching' },
    pending_confirm: { confirm: 'pooled' },
    pooled:          {},
  }[state]?.[event];
  if (!next) throw new Error(`非法状态转移: ${state} --${event}--> ?`);
  return next;
}

function nowTs() { return Date.now(); }

export function createProspectingSession({ tenantId, actor, _now } = {}) {
  if (!tenantId || !actor) throw new Error('createProspectingSession({tenantId, actor}) 必填');
  const ts = _now ?? nowTs();
  seq = (seq + 1) % 1296;          // 0-1295，同毫秒多建会话时保证 id 不同
  const sessionId = `ps_${tenantId}_${actor}_${ts.toString(36)}_${seq.toString(36)}`;
  // 并发隔离：同租户同 actor 旧会话先失效
  const prevId = ACTIVE.get(`${tenantId}:${actor}`);
  if (prevId) SESSIONS.delete(prevId);
  const session = {
    tenantId, actor, sessionId, state: 'searching',
    candidates: [], selected_ids: [], confirmed_ids: [],
    createdAt: ts, updatedAt: ts,
  };
  SESSIONS.set(sessionId, session);
  ACTIVE.set(`${tenantId}:${actor}`, sessionId);
  // 容量上限：保留最近 MAX_SESSIONS（剔除最旧，同步清理 ACTIVE 索引）
  while (SESSIONS.size > MAX_SESSIONS) {
    const oldestId = SESSIONS.keys().next().value;
    const oldest = SESSIONS.get(oldestId);
    SESSIONS.delete(oldestId);
    if (ACTIVE.get(`${oldest.tenantId}:${oldest.actor}`) === oldestId) {
      ACTIVE.delete(`${oldest.tenantId}:${oldest.actor}`);
    }
  }
  return sessionId;
}

export function getSession(sessionId) {
  const s = SESSIONS.get(sessionId);
  if (!s) return null;
  if (nowTs() - s.updatedAt > TTL_MS) {   // 超时失效
    SESSIONS.delete(sessionId);
    ACTIVE.delete(`${s.tenantId}:${s.actor}`);
    return null;
  }
  return s;
}

export function updateSession(sessionId, patch = {}) {
  const s = getSession(sessionId);
  if (!s) throw new Error(`prospecting session 不存在或已超时: ${sessionId}`);
  Object.assign(s, patch, { updatedAt: nowTs() });
  return s;
}

export function expireSession(sessionId) {
  const s = SESSIONS.get(sessionId);
  if (s) { SESSIONS.delete(sessionId); ACTIVE.delete(`${s.tenantId}:${s.actor}`); }
}

// 测试/诊断专用
export function _getSessionsInMemory() { return SESSIONS; }
