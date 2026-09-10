// src/http/server.js — HTTP 服务（Express 单端口） + 进程内 fetch 适配器（供测试驱动路由）
// 设计输入：docs/2026-08-24-ai-native-sales-crm-design.md §9 观测看板
import express from 'express';
import http from 'node:http';
import { createRoutes } from './routes.js';
import { createTenantRouter } from './tenantRouter.js'; // T6 租户管理面（admin 闸 + 第0闸）
import { createSseHub } from '../events/sse.js';
import { ensureGraph } from '../decision/ageGraph.js';
// SKILL 注册表持久化启动接线（第 16 项）：首启幂等灌种子 + 引擎 DB 启停态应用（D2/D3）
// 启动顺序铁律：先 seedSkills() 注册内存 skills Map（否则 applySkillRegistryToMemory 的 syncMemory
//   skills.get(slug) 恒 undefined → applied=0，DB 启停态从未真正作用于引擎）——2026-08-28 冒烟实证根治
import { seedSkillRegistry, applySkillRegistryToMemory } from '../skills/skillRegistry.js';
import { seedSkills } from '../skills/seed.js';
// S05 T6：财务逾期告警 hook（订阅 payment 域 payment_overdue_plan → payment_due_plan 告警）
import { registerFinanceAlertHook } from '../alerts/financeAlertHook.js';
// ③ 事件触发式复盘：订阅 decision 域 confirmed → 按 business_tier + 冷却窗自动建复盘任务
// 设计 docs/2026-09-01-event-triggered-retro-design.md；阈值走 config_store['event-retro']
import { registerRetroTrigger } from '../decision/retroTrigger.js';
// T21 J3 自动建议：实时偏差 → calibration 域 retro-suggestions → 作战室浮卡
// 启动即注册（订阅 decision 域 decision-created/outcome-set/feedback-set，样本足且偏差命中才出建议）
import { registerAutoSuggest } from '../calibration/autoSuggest.js';
import { GATE_SCENARIOS } from '../monitor/monitorStore.js';
// C1 事件触发式智能体派发（首批）：订阅 ontology 域 → 矩阵派发只读判定任务
// 设计 docs/2026-09-03-agent-event-trigger-design.md；落库钩子(ontology/hooks.js:120)已 emit ontology-sync，
//   挂载订阅器后业务粒子直写自动带出 agent 运行（根治「粒子写无 agent 订阅」设计缺口）。幂等。
import { registerAgentEventTrigger } from '../agent/eventTrigger.js';
// 审批业务参数后台化（铁律 2026-08-31）：启动即加载 config_store['approval-config']
//   → 引擎运行态兜底动作经 setApprovalControl 生效（无规则节点不再硬编码 AUTO_PASS）
import { setApprovalControl, readApprovalConfig } from '../approval/approvalConfig.js';
// ⑧ 编排层自动泵（方案C 根因②）：启动即接线 ready-queue-pump，否则 ready 任务永不被泵起、编排层假死
import { ensureTimers } from '../scheduler/timers.js';

// 真 embedding 默认启用（方案 B，2026-09-03）：DB 有可用 llm_config（hydrate 解密 api_key）→
//   自动 EMBEDDING_PROVIDER='model'，searchPrecedents 走真语义向量；未配置/测试环境保持 hash，零风险。
//   运行时亦可用显式 EMBEDDING_PROVIDER 覆盖。NODE_ENV=test 跳过（保证测试确定性、零外部依赖）。
if (process.env.NODE_ENV !== 'test' && !process.env.EMBEDDING_PROVIDER) {
  import('../llm/llmConfigStore.js').then(async (m) => {
    try {
      const cfg = m.hydrate(await m.getDefault());
      if (cfg && cfg.apiKey) {
        process.env.EMBEDDING_PROVIDER = 'model';
        console.log('[embedding] 真向量已启用（EMBEDDING_PROVIDER=model，来源 llm_config）');
      }
    } catch { /* 保持 hash（默认降级） */ }
  }).catch(() => {});
}

export function createApp() {
  const app = express();
  // 支付网关异步通知：微信 v3 需原始 JSON 验签（AES-GCM 解密 resource），支付宝为 form 表单。
  // 必须放在 express.json() 之前，否则 body 被提前解析、原始字节丢失导致验签失败。
  app.use('/api/billing/wechat/notify', express.raw({ type: 'application/json', limit: '1mb' }));
  app.use('/api/billing/alipay/notify', express.urlencoded({ extended: true, limit: '1mb' }));
  app.use('/api/billing/wechat/refund-notify', express.raw({ type: 'application/json', limit: '1mb' }));
  app.use('/api/billing/alipay/refund-notify', express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json());
  // 非结构化证据上传体解析（零 multipart 依赖）：仅 /api/assets/upload 走原始字节，
  // 其它路由仍由 express.json 处理。limit 是硬上限，业务上限走 config_store['sales-thresholds'].asset.max_mb。
  app.use('/api/assets/upload', express.raw({ type: 'application/octet-stream', limit: '64mb' }));
  const hub = createSseHub();
  createRoutes(app, hub);
  // T6 租户管理面（GET/POST /api/tenants；admin/sysadmin 闸 + 决策第0闸）
  app.use(createTenantRouter());

  // 启动接线（异步，不阻塞 listen；对齐 ensureGraph 先例——失败仅日志不阻断主服务）
  // 第一步必须 seedSkills()：内存 skills Map 注册（否则 applySkillRegistryToMemory 无对象可同步，DB 启停态落空）
  try { seedSkills(); } catch (e) { console.log(`[skill-registry] seedSkills fail: ${e.message}`); }
  // S05 T6：财务逾期告警 hook 注册（订阅 payment 域；subscribe 同步幂等，不阻塞启动）
  try { registerFinanceAlertHook(); } catch (e) { console.log(`[finance-alert-hook] register fail: ${e.message}`); }
  // ③ 事件触发式复盘注册（订阅 decision 域 confirmed；幂等，异常仅日志不阻断启动）
  try { registerRetroTrigger(); } catch (e) { console.log(`[retro-trigger] register fail: ${e.message}`); }
  // T21 J3 自动建议注册：监听 decision 域（新决策/结果回写/反馈回写）→ 偏差触达时经 SSE 推浮卡
  try { registerAutoSuggest({ scenarios: GATE_SCENARIOS }); } catch (e) { console.log(`[auto-suggest] register fail: ${e.message}`); }
  // P0-2（2026-09-10）：业务结果自动回写订阅器注册。
  //   此前该函数全仓仅定义、无任何调用（探针 D4 实测真自动 outcome = 0），⑤ 边从未通电。
  //   注意：仅注册不足以生效，还须在 crm.outcome_event_map 播种规则（见 db/seed-outcome-event-map.sql）。
  try { registerOutcomeIngester(); } catch (e) { console.log(`[outcome-ingester] register fail: ${e.message}`); }
  seedSkillRegistry()
    .then((r) => console.log(`[skill-registry] seed inserted=${r.inserted}/${r.total}`))
    .catch((e) => console.log(`[skill-registry] seed fail: ${e.message}`))
    .then(() => applySkillRegistryToMemory())
    .then((r) => console.log(`[skill-registry] memory applied=${r.applied}/${r.total}`))
    .catch((e) => console.log(`[skill-registry] memory apply fail: ${e.message}`));
  // 审批业务参数加载到引擎运行态（失败仅日志，不阻断主服务；缺省回退 ASSIGN_ADMIN 安全默认）
  // 2026-09-05 G2：服务启动加载平台基线（'system' 模板），租户运行时各自覆盖
  readApprovalConfig('system')
    .then(setApprovalControl)
    .catch((e) => console.log(`[approval-config] load fail: ${e.message}`));
  // ⑧ 编排层自动泵：接线 ready-queue-pump（幂等单例，失败仅日志不阻断主服务）
  try { ensureTimers(); } catch (e) { console.log(`[agent-pump] ensureTimers fail: ${e.message}`); }
  // 事件触发智能体派发：接线 ontology 域订阅（幂等，异常仅日志不阻断主服务）
  try { registerAgentEventTrigger(); } catch (e) { console.log(`[agent-event-trigger] register fail: ${e.message}`); }
  // 方案 B：mcp_identity.person_id 一次性幂等回填（仅 UPDATE；失败仅日志不阻断启动）
  import('../portal/mcpIdentity.js').then((m) => m.backfillPersonIds())
    .then((n) => { if (n > 0) console.log(`[mcp-identity] person_id backfilled=${n}`); })
    .catch((e) => console.log(`[mcp-identity] person_id backfill fail: ${e.message}`));

  // 进程内 fetch 适配器：不监听常驻端口即可驱动 Express 路由（无额外依赖，便于 vitest 直测）
  app.fetch = (path, opts = {}) => new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { host: '127.0.0.1', port, path, method: opts.method || 'GET', headers: opts.headers || {} },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            server.close();
            res.status = res.statusCode; // 对齐 express res.status
            res.json = async () => JSON.parse(data || '{}');
            res.text = async () => data;
            resolve(res);
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  });

  return app;
}

export function startServer(port = 3000) {
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`[crm] 阶段1 服务已启动: http://127.0.0.1:${port}`);
  });
  // P0 AGE 启动探活：探测决策网络图可用性（失败仅日志，不阻断主服务）
  ensureGraph()
    .then((r) => console.log(`[AGE] decision network available=${r.available ?? false}`))
    .catch(() => {});
  // 订阅到期停服巡检（2026-09-06 交付补齐）
  //   设计依据 docs/2026-09-04-tenant-subscription-billing-design.md §5.1：expires_at 过且 grace 过
  //   → 订阅转 expired + tenants.plan 回落 default_plan(free) → 权益自动降级（软停服，不回收数据）。
  //   此前 expireSweep() 仅有实现、无调度（仅单测调用），生产永不会执行 → 到期租户不会降级。
  //   放在 startServer（而非 createApp）：vitest 用 createApp+app.fetch 时不启定时器，避免测试进程挂住。
  startSubscriptionSweeper();
  return server;
}

// 订阅到期巡检定时器：首次延迟 60s（等启动接线完成），其后每 6 小时一次；失败仅日志不阻断
const SUB_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let subSweeperTimer = null;
export function startSubscriptionSweeper({ intervalMs = SUB_SWEEP_INTERVAL_MS } = {}) {
  if (subSweeperTimer) return subSweeperTimer; // 幂等单例
  const run = async () => {
    try {
      const { expireSweep } = await import('../billing/subscriptionService.js');
      const rows = await expireSweep();
      if (Array.isArray(rows) && rows.length) {
        console.log(`[subscription-sweeper] 到期停服 ${rows.length} 租户：${rows.map((r) => r.tenant_id).join(',')}`);
      }
    } catch (e) {
      console.log(`[subscription-sweeper] sweep fail: ${String(e?.message || e)}`);
    }
  };
  subSweeperTimer = setInterval(run, intervalMs);
  if (subSweeperTimer.unref) subSweeperTimer.unref(); // 不阻止进程退出
  setTimeout(run, 60 * 1000).unref?.();
  return subSweeperTimer;
}
export function stopSubscriptionSweeper() {
  if (subSweeperTimer) { clearInterval(subSweeperTimer); subSweeperTimer = null; }
}

if (process.argv[1]?.endsWith('server.js')) {
  const port = Number(process.env.PORT || 3000);
  startServer(port);
}
