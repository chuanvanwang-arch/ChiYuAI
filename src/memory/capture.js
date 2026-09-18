// src/memory/capture.js — 事件总线订阅者（residue 零摩擦单汇点）
import { appendMemory } from './memoryLog.js';
import { on } from '../events/bus.js';

// 决策由主轴委托写入，避免双写；trace/metering 是系统自监控流，不是业务事实；
// memory 自域排除——防「蒸馏写记忆 → emit → 再被捕获」的自激回路。
const BLOCKED_DOMAINS = new Set(['decision', 'trace', 'metering', 'system', 'memory']);

// 白名单（2026-09-10 C4）：原实现 on('*') 订阅全量域，把 170 处 emit('trace', …) 全部
//   写成业务记忆（生产 62 万条 event:trace:* 噪声，占记忆表 99.99%），且与
//   distillScheduler 的 emit('trace','memory-distill-run') 形成自激：蒸馏→写记忆→再被捕获。
//   改为域名白名单：只有**业务事实域**才沉淀为记忆。清单来源：全仓 emit 域名实测统计
//   （crm/approval/task/particle/payment/alert/calibration/connector/crm-risk-alert）
//   + 预留业务对象域（customer/deal/quote/contact/lead/contract）。
// 可运营扩展：config_store['memory-capture-domains'] = { domains: [...] } 覆盖，缺省用本常量。
const DEFAULT_CAPTURE_DOMAINS = [
  'crm', 'approval', 'task', 'particle', 'payment', 'alert', 'calibration', 'connector', 'crm-risk-alert',
  'customer', 'deal', 'quote', 'contact', 'lead', 'contract',
  'discovery',
];

let activeDomains = new Set(DEFAULT_CAPTURE_DOMAINS);
let unsubs = [];

// 纯函数式准入判定（可单测，无 DB / 无总线）
export function isCapturable(domain) {
  const d = String(domain || 'event');
  if (BLOCKED_DOMAINS.has(d)) return false;
  return activeDomains.has(d);
}

export function getCaptureDomains() {
  return [...activeDomains];
}

/** 覆盖捕获白名单（测试 / 运营配置用）。被 BLOCKED 的域永远不生效——硬闸不可被配置绕过。 */
export function setCaptureDomains(list) {
  const next = new Set((Array.isArray(list) ? list : []).map((d) => String(d)).filter((d) => !BLOCKED_DOMAINS.has(d)));
  activeDomains = next.size ? next : new Set(DEFAULT_CAPTURE_DOMAINS);
  resubscribe();
  return [...activeDomains];
}

/** 从 config_store 读取白名单覆盖（无配置 / 读取失败 → 保持缺省，不阻断）。 */
export async function loadCaptureDomains({ tenantId = 'system' } = {}) {
  try {
    const { readConfig } = await import('../config/configStore.js');
    const cfg = await readConfig('memory-capture-domains', { tenantId });
    const list = Array.isArray(cfg?.domains) ? cfg.domains : null;
    if (list) return setCaptureDomains(list);
  } catch { /* 配置不可用 → 缺省白名单生效，绝不因配置失败放开全量 */ }
  return getCaptureDomains();
}

function resubscribe() {
  unsubs.forEach((f) => { try { f(); } catch { /* 退订失败不影响 */ } });
  // 逐域订阅，**绝不 on('*')** —— 全量订阅正是噪声根源。
  unsubs = [...activeDomains].map((d) => on(d, (msg) => {
    captureMemory({ domain: msg.domain, type: msg.type, payload: msg.summary, actor: msg.summary?.actor })
      .catch(() => {});
  }));
}

export async function captureMemory(event) {
  if (!event || !event.type) return { ok: false, reason: 'no-event' };
  const domain = event.domain || 'event';
  if (!isCapturable(domain)) return { ok: false, reason: 'skipped-domain' };
  // ── 边沿写入（2026-09-18，D9 整改）─────────────────────────────────────────
  //   状态型信号在「去重刷新」（状态未变）时不再沉淀为记忆。
  //   背景：salesDailyScan 的聚合信号（visit_shortfall / info_collect_lag）每次巡检
  //   都重发 alert 事件，而 createAlertWithDb 命中稳定 dedup_key 时只**刷新既有行**
  //   （refreshed=true）——状态没变却在记忆表新增一行（24h 真库实测 3156 行 = 97.7% 噪声）。
  //   发射侧以 payload.state_refresh=true 显式标记「本次仅刷新、状态无变化」，本层据此跳过。
  //   语义边界：**不影响 SSE** —— emit 仍照发、订阅前端照常收到实时刷新；只是不再写记忆。
  //   判据：只有显式 === true 才跳过，缺省/undefined/false 一律照常捕获（保守，不误伤新事件）。
  if (event.payload && event.payload.state_refresh === true) return { ok: false, reason: 'state-refresh' };
  const res = await appendMemory({
    topic: event.topic || `event:${domain}:${event.type}`,
    kind: event.kind || 'event',
    payload: event.payload ?? {},
    layer: event.layer || 'L-Workspace',
    actor: event.actor,
    eventType: event.type,
    explicit: !!event.explicit,
    valueHorizonDays: event.valueHorizonDays ?? 30,
  });
  return res;
}

export function registerCaptureSubscriber() {
  resubscribe();
  return () => { unsubs.forEach((f) => { try { f(); } catch { /* 忽略 */ } }); unsubs = []; };
}
