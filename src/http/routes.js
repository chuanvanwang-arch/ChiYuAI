// src/http/routes.js — 读直连 / 写通道 / 看板 / 装配校验 / SSE 端点
// 设计输入：03 编排设计（读默认直连；写通道阶段 1 骨架，action-confirm/HITL 阶段 2 接入）
import { fileURLToPath } from 'node:url';
import express from 'express';
import { queryParticles, getParticle, normalizeStage } from '../particles/particleRepo.js';
import { listTasks, resetTask } from '../kanban/kanban.js';
import { assertAgentAssembly } from '../agent/agents.js';
import { agentSpecs } from '../agent/agentSpec.js';
import { computeCompliance } from '../agent/contractMonitor.js';
import { upsertFeedback, mirrorFeedback, markSuccess } from '../agent/feedbackStore.js';
import { pumpReadyTasks } from '../kanban/scheduler.js';
import { actionExecutor } from '../action/executor.js';
import { seedActions } from '../action/seed-actions.js';
import { getAction } from '../action/registry.js';
import { distillMemory } from '../memory/memoryLog.js';
import { registerCaptureSubscriber, loadCaptureDomains } from '../memory/capture.js';
import { ensureTimers } from '../scheduler/timers.js';
import { seedConnectorActions } from '../connectors/connectorActions.js';
import { seedDiscoveryActions } from '../action/discoveryActions.js';
import { registerBuiltinAdapters } from '../connectors/discovery/builtinAdapters.js';
// 非结构化证据挂接（2026-08-31）：上传/下载路由（staging，免 confirm）
import { createAssetRoutes } from '../assets/upload.js';
import { registerMonitorSubscriber, ensureMonitorSchema } from '../monitor/monitorSubscriber.js';
import { GATE_SCENARIOS, getGateMetrics, getSevenDimCoverage, getDecisionList, getGateOutcome } from '../monitor/monitorStore.js';
// 决策网络视图 API（C2/C4：因果链 / 影响地图 / 审计导出；与既有 /api/monitor/* 并列）
import { traceDecision, getImpact } from '../decision/decisionTrace.js';
import { exportAudit, exportTurtle } from '../decision/provenance.js';
import { toStageCode, isOpenStage, isPoolStage, normalizeDealStage } from '../sales/stageTaxonomy.js'; // 阶段归一 + 「在跟=非终态」判定（2026-09-09）+ 公海排除/归一（2026-09-11 T9）
import { writeOutcome, listOutcomes } from '../decision/outcome.js';
import { setDecisionFeedback } from '../decision/feedback.js';
import { traceRootCause } from '../decision/traceRootCause.js';
import { classifyRootCause } from '../decision/rootCauseClassifier.js';
import { advise } from '../decision/adviseService.js'; // 对话驱动建议（2026-09-08 T7）：NL 生成页面时附带决策建议卡
import { detectConflicts } from '../decision/conflict.js'; // P4 冲突保留：4 问审计 Q3 数据源
// P0② 出参脱敏中间件（展示层，不落库；字段表 config_store['mask-fields'] 可覆盖）
import { createMaskMiddleware } from './middleware/mask.js';
// P1③ 审计字段历史投影（audit_event.payload → 字段级 before→after）
import { projectFieldHistory } from './fieldHistory.js';
// P1③ 复用 P0① 单一权限谓词：字段历史同样受 data_scope 约束
import { scopePredicateFor } from '../context/scope.js';
import { computeAudit4q, aggregateAuditability } from '../decision/auditability.js'; // T-AUDIT4Q 4 问共享评分（单一事实源）
import { listTypedEdges, enrichTraceWithRelType } from '../decision/relation.js'; // T11 7 类边权威读
import { getDecisionContextSnapshot, getPlatformSupplyHealth, getSnapshotSuppliedMap } from '../context/snapshotStore.js'; // Phase4 三层一屏：快照读取 + 供给健康
// LLM 配置密钥字段加解密（configRouter llm 端点注入；api_key 加密存储 + GET 掩码）
import { encryptSecret, maskSecret } from '../llm/secret.js';
// 粒子详情组装（12 文档 §7-2 前端数据来源展示的 API 契约；query 依赖集中在调用处）
import { buildParticleDetail } from './particleDetail.js';
// 粒子详情受控 Schema 组装（S13 面：?schema=1 返回 detail 型受控 schema）
import { buildParticleDetailSchema } from './particleDetailRouter.js';
// 门户 NL→Page 运行时（pageStore 无副作用，静态导入；避免函数内顶层 await 触发 Rollup 编译失败）
import { createPageFromNl, listPages, publishPage, revertPage, getPageHtml } from '../page/pageStore.js';
// 全站死信息活体化（方案 B）：7 页 reasoning-trace 判定内核（label→facts 判定表）
import { buildReasoningSteps } from '../page/reasoningSteps.js';
// 粒子属性元模型读直连（G1 T6：/api/meta-attr 桥接；写走 data-particle-attr-update 第 0 闸）
import { listMetaAttr } from '../metaAttr/metaAttrRepo.js';
// 配置中心通用端点（S16–S33：configRouter 写经第0闸 + 七维拦截）
import { createConfigRouter, createIntegrationSecretRouter, createIntegrationProviderRouter } from './configRouter.js';
// §15 权限重分组：配置中心注册表闸（CONFIG_ITEMS.level → 端点级 ADMIN/三角色，先于各路由第0闸）
import { createConfigLevelGate } from './middleware/rbac.js';
import { CONFIG_ITEMS } from '../portal/configCenter.js';
// 多条 LLM 配置管理（T3：crm.llm_config 表；路径 /api/config/llm-configs*，与旧单条 /api/config/llm 并存过渡）
import { createLlmConfigRouter } from './llmConfigRouter.js';
// S20 七维矩阵端点（场景×七维 required_dims；复用 decisionScenario 内核；sysadmin 闸 + 第0闸）
import { createSevenDimRouter } from './sevenDimRouter.js';
// S05 T5：财务应收配置后台化（config_store['finance-receivables'] + sysadmin 闸 + 决策第0闸）
import { createFinanceReceivablesConfigRouter } from './financeReceivablesConfigRouter.js';
// S13：指名客户目标指标配置后台化（config_store['named-account-targets'] + sysadmin 闸 + 决策第0闸）
import { createNamedAccountTargetsRouter } from './namedAccountTargetsRouter.js';
// 指名客户分配写通道（决策第0闸 + 审计边 named_assignment + 软停用；Task4 已完成）
import { createNamedAccountAssignRouter } from './namedAccountAssignRouter.js';
import { createBehaviorStandardRouter } from './behaviorStandardRouter.js';
import { createSalesThresholdsRouter } from './salesThresholdsRouter.js';
import { createFunnelRouter } from './funnelRouter.js';
import { mergedThresholds } from '../sales/salesThresholds.js';
import { mergedBehaviorStd } from '../sales/behaviorStandard.js';
import { createCalibrationRouter } from './calibrationRouter.js';
import { createContractRouter } from './contractRouter.js';
import { createBusinessTierRouter } from '../portal/businessTier.js';
import { createRbacRouter } from '../portal/rbacMatrix.js';
import { createDecisionScenarioRouter } from '../portal/decisionScenario.js';
import { createUserRouter } from '../portal/userManagement.js';
import { createOntologyRouter } from '../portal/ontologyConfig.js';
import { createSystemSettingsRouter } from '../portal/systemSettings.js';
import { createMemoryConfigRouter } from '../portal/memoryConfig.js';
import { createApprovalFlowRouter } from '../portal/approvalFlow.js';
import { createAlertRuleConfigRouter, hydrateAlertRules } from '../portal/alertRuleConfig.js';
import { createMcpIdentityRouter } from '../portal/mcpIdentity.js';
import { createBusinessBoardRouter } from '../portal/businessBoard.js';
import { createConnectorRouter } from './connectorRouter.js';
import { createBillingRouter } from './billingRoutes.js';
import { createDiscoveryRouter } from './discoveryRoutes.js'; // T13：线索发现只读候选池端点
import { createAgentConfigRouter } from '../portal/agentConfig.js';
import { createSkillRegistryRouter } from '../portal/skillRegistry.js';
// 受控配置页工厂（S17/S19/S23/S24…：schema + SQL + 列映射 → /api/page/<id>，renderPage 唯一出口）
import { createControlledPagesRouter } from './controlledConfigPages.js';
// 阶段3 业务读直连（T3 池/报价/合同/发票/订单管理端点；业务数据=粒子 payload，读直连默认通道）
import { query, queryWrite, pool } from '../db.js';
import { getPoolConfig, setPoolConfig, readPoolConfig, writePoolConfig } from '../sales/pool.js';
// S13 目标指标（named-account-targets）：account-360/named-accounts 消费的达标判定纯函数
import { visitTargetFor, mergedTargets, metricDimensions } from '../sales/namedAccountTargets.js';
// S13 指名客户监测看板聚合（owner 过滤 + 四维 + 达标缺口；纯函数，见 namedAccountBoard.js）
import { buildNamedAccountBoard, boardSummary, listUnassignedAccounts, listOrphanDeals } from '../sales/namedAccountBoard.js';
import { pipelineMetrics } from '../portal/scoring.js';
// S05 财务应收聚合（T1：合同维应收/逾期/账龄；paymentService 对账纯函数）
import { reconcilePlan } from '../sales/paymentService.js';
// S05 T4：差额超阈值预警写回（createAlert 落库 + bus 'alert' 域转播，与 alertHook 同链路）
import { createAlert } from '../alerts/alertStore.js';
import { emit } from '../events/bus.js';
// B-B1（2026-09-16 主动运行时 S1）：alertEndpoints 8 端点挂载（此前清单在、处理器在、挂载方没来）
import { buildAlertHandlers, ALERT_ENDPOINTS } from '../alerts/alertEndpoints.js';
// 信号端点（2026-09-16 主动运行时 S1）：crm.signal 统一收口列表/确认/否决
import { createSignalStore } from '../signal/store.js';
import { createAdoption } from '../signal/adoption.js'; // T18 建议卡采纳/否决（第 0 闸）
// 门户真实登录认证（v2 双页：Home.html → token → index.html）
import { login, resolveMe } from './auth.js';
import { handleRegister } from './selfRegister.js'; // 自助注册（公开，免 admin 闸；按公司名自动判定租户）
import { handleActivate, handleResend } from './activation.js'; // 自助注册激活闭环：激活 / 重发激活码
import { scopeTenant, scopeOf, applyTenantOverride } from './tenantScope.js';
import { readConfig as storeReadConfig } from '../config/configStore.js';
import { registerDecisionReadRoutes } from './decisionReadRoutes.js'; // B6/B7 决策读模型路由（自检卡/九尺子/思维卡/场景chip）
import { registerPropagationRoutes } from './propagationRoutes.js'; // 参数传播中枢（继承/下发/推广；全经决策第0闸）

// 多租户配置读取（枢轴 4）：按 scopeTenant(me) 读 config_store，回退 system 平台默认
async function readTenantConfig(key, me) {
  try { const r = await storeReadConfig(key, { tenantId: scopeTenant(me) }); return r?.value || {}; }
  catch { return {}; }
}
// 自主决策引擎（Task 3：新建商机经第 0 闸自主分级，无决策不写）
import { requireDecision } from '../decision/autonomyEngine.js';
// 校准 P0：升级决策落地待办（决策 → 待办 → 人工处置链路）+ 人工处置回写唯一出口
import { createTask } from '../kanban/kanban.js';
import { classifyRequirement } from '../agent/classify.js';
import { recordHumanDisposition } from '../decision/disposition.js';
// 第0闸降级路径：非 DEAL 无专属决策场景 → 记录决策事件（对齐 configRouter.produceDecision 先例）
import { recordDecisionEvent, getDecision, backfillDecisionInvolvedEntity } from '../decision/decisionRepo.js';
// 待办工作台四视角（G3：成品页数据面 /api/workbench，复用 renderPage；读直连无第0闸）
  import { createWorkbenchRouter } from './workbenchRouter.js';
  // 页面市场（方案 C 收口：33 受控 schema 枚举/预览；导入即执行 pages/index.js 注册副作用，生产启动即注册）
  import { createPageMarketRouter } from './pageMarketRouter.js';
  import '../pages/index.js'; // 33 受控面注册（副作用；registry.allPages() 是页面市场单一事实源）
  // S02 首页受控渲染（Task 11 收尾：前台经渲染器出片，非静态骨架；renderPage 唯一出口）
  import { renderPage } from '../page/renderer.js';
  import { schema as S02_SCHEMA } from '../pages/S02.schema.js';
  import { schema as S03_SCHEMA } from '../pages/S03.schema.js';
  import { schema as S04_SCHEMA } from '../pages/S04.schema.js';
  import { schema as S05_SCHEMA } from '../pages/S05.schema.js';
  import { schema as S06_SCHEMA } from '../pages/S06.schema.js';
  import { schema as S07_SCHEMA } from '../pages/S07.schema.js';
  import { schema as S08_SCHEMA } from '../pages/S08.schema.js';
  import { schema as S09_SCHEMA } from '../pages/S09.schema.js';
  import { schema as S10_SCHEMA } from '../pages/S10.schema.js';
  import { schema as S11_SCHEMA } from '../pages/S11.schema.js';
  import { schema as S12_SCHEMA } from '../pages/S12.schema.js';
  import { schema as S14_SCHEMA } from '../pages/S14.schema.js';
  import { schema as S15_SCHEMA } from '../pages/S15.schema.js';
  // S36 漏斗质量看板（受控页签，funnel-design §5.3）
  import { schema as S36_SCHEMA } from '../pages/S36.schema.js';
  import {
    mantOk, funnelZone, forecastClass, weightedAmount, salesPotential, jitterRate, forecastBreach,
    commitAccuracy,
  } from '../sales/funnelQuality.js';
  // mergedThresholds 顶部已声明（54 行）——避免 ESM 严格模式重复声明错误
  import { schema as S21_SCHEMA } from '../pages/S21.schema.js';
  // S34 今日优先·高匹配商机明细（FIT 钻取目标）；S21 已被 SKILL 注册表占用，故用空闲编号 S34
  import { schema as S34_SCHEMA } from '../pages/S34.schema.js';
  import { listSkillRegistry } from '../skills/skillRegistry.js';
  // 客户洞察页（S35）：聚合四视图 + 字段级权限（双页分离第二页）
  import { loadProfile } from '../context/roleProfiles.js';
  import { schema as S35_SCHEMA } from '../pages/S35.schema.js';
  import { applyScopeFilter, applyFieldPerms, maskMetricsByPerm, buildTimelineRows, buildTransactionRows, buildMetrics, loadRelatedParticles, loadTimelineSources, loadDecisions, loadDecisionTrace, resolveActor } from '../account/insightService.js';

// Task 3（2026-08-27 UI/导航/规范重构）：系统页 RBAC 守卫（admin 独享；非 admin 403）
// 与 layoutMenu.js ADMIN_MENU（menuFor 角色过滤）双保险：菜单藏 + 路由拦
function requireAdminRole(req, res, next) {
  const me = resolveMe(req);
  if (me?.ok && me.role === 'admin') return next();
  res.status(403).json({ error: '需要 admin 权限' });
}

export function createRoutes(app, hub) {
  // P0② 出参脱敏中间件（docs/2026-09-05-security-hardening-design.md §3.2）：
  // 敏感端点（报价/客户/合同详情）响应前做展示层脱敏（个人字段默认***，商业仅 exec/sysadmin）；
  // 字段表可经 config_store['mask-fields'] 覆盖（出厂兜底在 mask.js）。先于具体路由。
  app.use('/api/quote', createMaskMiddleware());
  app.use('/api/account/', createMaskMiddleware());
  app.use('/api/contract/', createMaskMiddleware());
  // §15.3 配置中心注册表闸：以 configCenter.js CONFIG_ITEMS 为单一事实源（level+endpoint），
  // 命中端点统一施加 系统级(仅 ADMIN)/租户级(三角色) 闸；未注册路径直通。先于各路由（双闸串行：角色闸→第0闸）
  app.use(createConfigLevelGate(CONFIG_ITEMS));
  // 非结构化证据上传/下载（设计 docs/2026-08-31-unstructured-asset-attach-design.md §4.1）
  app.use(createAssetRoutes());
  // 配置中心通用端点（S16–S33 面共用；写经第0闸 + 七维拦截；决策相关面挂 requireDecision）
  // Phase 3 逐面补 router 时在此追加 createConfigRouter 实例
  // LLM 配置 = 平台级（方案 B：LLM 不租户隔离，恒 system）；声明 scope:'platform' 强制 GET/PUT 落 (system,llm)
  app.use(createConfigRouter({ key: 'llm', role: 'sysadmin', secretFields: ['api_key'], scope: 'platform' }, { encryptSecret, maskSecret }));
  // 多条 LLM 配置（T3）：列表/新增/改/软删/设默认/测试连通，写经第0闸 + sysadmin + 密钥加密脱敏
  app.use(createLlmConfigRouter({ encryptSecret, maskSecret }));
  app.use(createSevenDimRouter());
  // S05 T5：财务应收配置后台化（config_store['finance-receivables'] + sysadmin 闸 + 决策第0闸）
  app.use(createFinanceReceivablesConfigRouter());
  // 平台级计费域（多租户 Token/账号计费 + 缴费 + 对账 + 导出；档位/权益来自 config_store['billing-plans']）
  app.use(createBillingRouter());
  // T13：线索发现只读候选池端点（GET /api/discovery/candidates；租户隔离，零写零删；评分重校准走 HITL）
  app.use(createDiscoveryRouter());
  // S13：指名客户目标指标配置后台化（config_store['named-account-targets'] + sysadmin 闸 + 决策第0闸）
  app.use(createNamedAccountTargetsRouter());
  app.use(createNamedAccountAssignRouter());
  app.use(createBehaviorStandardRouter());
  // 判定阈值配置后台化（config_store['sales-thresholds']，配置中心 id32）
  app.use(createSalesThresholdsRouter());
  // 审批业务参数后台化（config_store['approval-config']，配置中心 id34，写经决策第0闸+sysadmin+七维拦截）
  app.use(createConfigRouter({ key: 'approval-config', role: 'sysadmin', decisionScene: 'config-change' }));
  // ③ 事件触发式复盘配置后台化（config_store['event-retro']，配置中心 id35，写经决策第0闸+sysadmin）
  // 阈值配置化铁律：min_tier / cooldown_hours 不得硬编码，代码仅存 DEFAULT_EVENT_RETRO_CFG 出厂建议值
  app.use(createConfigRouter({ key: 'event-retro', role: 'sysadmin', level: 'system', decisionScene: 'config-change' }));
  // ④ 场景路由（故事线/图谱/结构化）配置后台化（config_store['context-routing']，配置中心 id36，写经决策第0闸+sysadmin）
  // 融合设计批准 2026-09-02：dims/scene_matrix/thresholds 出厂默认在 src/context/routing.js，管理员经配置中心调整；缺省回退全轨
  app.use(createConfigRouter({ key: 'context-routing', role: 'sysadmin', level: 'system', decisionScene: 'config-change' }));
  // ⑤ C2 审计链巡检配置后台化（config_store['provenance-patrol']，配置中心 id37，写经决策第0闸+sysadmin）
  //   阈值配置化铁律：巡检间隔与单批上限不得硬编码，代码仅存出厂默认值（3600000ms / 200 条）
  // ⑤ 配置值平台级（巡检器读 system）；巡检「执行」按租户循环（T11）——两处粒度不同，注释见 T11
  app.use(createConfigRouter({ key: 'provenance-patrol', role: 'sysadmin', decisionScene: 'config-change', scope: 'platform' }));
  // ⑥ C4 先例检索配置后台化（config_store['precedent-conf']，配置中心 id38，写经决策第0闸+sysadmin）
  //   四分量权重(jaccard/category/graphDepth/vector)与 minSimilarity 阈值不得硬编码，缺省回退出厂值
  app.use(createConfigRouter({ key: 'precedent-conf', role: 'sysadmin', decisionScene: 'config-change' }));
  // 事件触发智能体派发配置（C1 首批）：GET/PUT /api/config/agent-event-trigger，写经决策第0闸+sysadmin
  app.use(createConfigRouter({ key: 'agent-event-trigger', role: 'sysadmin', level: 'system', decisionScene: 'config-change' }));
  app.get('/agent-event-trigger-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/agent-event-trigger-config.html', import.meta.url))));
  // 夜间批量复盘配置（R3 登记，config_center id43）：GET/PUT /api/config/decision-retro，写经决策第0闸+sysadmin
  app.use(createConfigRouter({ key: 'decision-retro', role: 'sysadmin', level: 'system', decisionScene: 'config-change', scope: 'platform' }));
  // 场景路由 A/B 实验配置（config_center id44，2026-09-05 P1 注册）：GET/PUT /api/config/routing-explore
  // 消费端（routingExperiment.js / routingReview.js / assembler.js）恒读 config_store['routing-explore']，未挂载则写不进去、配置卡不可视。
  app.use(createConfigRouter({ key: 'routing-explore', role: 'sysadmin', level: 'system', decisionScene: 'config-change' }));
  // 线索发现规则后台化（配置中心 id46）：PUT 结构校验前置 —— 不修改共享 configRouter 本体
  // Express 按注册序执行：本 app.put 先于下面的 app.use(router) 命中同路径，校验后 next() 交棒
  app.put('/api/config/discovery-rules', (req, res, next) => {
    const v = req.body?.value;
    if (v && typeof v === 'object') {
      const missing = ['icp', 'providers', 'signals'].filter((k) => v[k] === undefined);
      if (missing.length) {
        return res.status(400).json({ error: `discovery-rules 缺结构键: ${missing.join(',')}` });
      }
    }
    next();
  });
  // GET/PUT /api/config/discovery-rules（写经决策第0闸 + sysadmin 闸；scope 默认 tenant = 租户级差分）
  app.use(createConfigRouter({ key: 'discovery-rules', role: 'sysadmin', decisionScene: 'config-change' }));
  app.get('/discovery-rules.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/discovery-rules.html', import.meta.url))));
  // 外部数据接入：加密凭据写端点（T13，仅 ADMIN/sysadmin；明文不落库）
  app.use(createIntegrationSecretRouter());
  // 外部数据接入：租户自有实例声明 CRUD（2026-09-14 补充，仅 ADMIN/sysadmin；禁物理删除→enabled 软停用）
  app.use(createIntegrationProviderRouter());
  app.use(createFunnelRouter());
  // ─── S05 财务应收聚合端点（T1）───
  // 合同维：应收余额=Σplan−Σpaid；逾期天数=plan_end−today(plan_status≠done)；账龄读 config_store aging_buckets；发票对账状态
  // 角色闸：仅 finance（roleProfiles.js:17 data_scope 含 payment/contract/invoice）
  app.get('/api/finance/receivables', async (req, res) => {
    try {
      let me;
      try { me = await resolveMe(req); } catch { me = { ok: false }; }
      if (!me?.ok || (me.role !== 'finance' && me.role !== 'admin')) return res.status(403).json({ error: '需要 finance 角色' });
      const contracts = await queryParticles({ type: 'CRM_CONTRACT', tenantId: applyTenantOverride(req, me), limit: 200 }).catch(() => []);
      const [plans, records, invoices] = await Promise.all([
        queryParticles({ type: 'CRM_PAYMENT_PLAN', tenantId: applyTenantOverride(req, me), limit: 500 }).catch(() => []),
        queryParticles({ type: 'CRM_PAYMENT_RECORD', tenantId: applyTenantOverride(req, me), limit: 500 }).catch(() => []),
        queryParticles({ type: 'CRM_INVOICE', tenantId: applyTenantOverride(req, me), limit: 500 }).catch(() => []),
      ]);
      // 账龄分层 + 差额阈值（读 config_store，缺失则用缺省；按租户回退 system 默认）
      const finCfg = await readTenantConfig('finance-receivables', me);
      const aging = finCfg.aging_buckets || [[0, 30], [31, 60], [61, 90], [91, 9999]];
      const bucketOf = (d) => {
        const b = aging.find(([a, z]) => d >= a && d <= z);
        return b ? `${b[0]}-${b[1]}` : `${aging[aging.length - 1][0]}+`;
      };
      // 合同维直接 Σ 聚合：recordsOnly 挂 contract_id（paymentService.createPaymentRecord 无 plan_id）
      // → 不能按 plan 分桶 reconcileContract，改为合同维 Σplan / Σpaid（record.id 与 plan.id 无关联，真实模型即如此）
      const out = contracts.map((ct) => {
        const cid = ct.id;
        const cp = plans.filter((x) => x.payload?.contract_id === cid);
        const cr = records.filter((x) => x.payload?.contract_id === cid);
        const planTotal = cp.reduce((s, p) => s + (Number(p.payload?.plan_amount) || 0), 0);
        const paidTotal = cr.reduce((s, r) => s + (Number(r.payload?.paid_amount) || 0), 0);
        const receivable = planTotal - paidTotal;
        // 逾期：plan_end < today && plan_status !== 'done'
        const overduePlans = cp.filter((p) => {
          const end = p.payload?.plan_end ? new Date(p.payload.plan_end) : null;
          return end && end < new Date() && p.payload?.plan_status !== 'done';
        });
        const maxDue = overduePlans.reduce((m, p) => {
          const d = Math.ceil((new Date() - new Date(p.payload.plan_end)) / 86400000);
          return Math.max(m, d);
        }, 0);
        const inv = invoices.filter((x) => x.payload?.contract_id === cid);
        return {
          contract_id: cid,
          tenant_id: ct.tenant_id,
          contract_title: ct.payload?.name || ct.slug || cid,
          plan_total: planTotal,
          paid_total: paidTotal,
          receivable,
          overdue: overduePlans.length > 0,
          overdue_days: maxDue,
          aging_bucket: bucketOf(maxDue),
          invoice_status: inv[0]?.payload?.reconcile_status || 'none',
        };
      });
      // S05 T4：差额超阈值预警写回（聚合后扫描 out；缺口占比 = receivable/plan_total 超阈值 → createAlert + bus alert 域转播）
      // 阈值读 config_store['finance-receivables'].gap_threshold_pct（缺省 5）；fail-open 不阻断主流程（与 paymentService 同纪律）
      const gapThreshold = finCfg.gap_threshold_pct ?? 5;
      for (const c of out) {
        if (c.receivable <= 0) continue;
        const pct = c.plan_total > 0 ? Math.round((c.receivable / c.plan_total) * 100) : 0;
        if (pct >= gapThreshold) {
          try {
            const a = createAlert({
              kind: 'payment_gap',
              severity: 'medium',
              target_role: 'finance',
              particle_id: c.contract_id,
              payload: { contract_id: c.contract_id, gap: c.receivable, gap_pct: pct },
            });
            if (a.ok) emit('alert', 'alert_created', { alert: a.alert, kind: 'payment_gap' });
          } catch { /* fail-open：预警失败不阻断应收主流程 */ }
        }
      }
      res.json({ contracts: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  // S05 T2/T5：财务应收看板页 + 财务应收配置页路由（sendFile 实时读 src/web，重启非必需）
  app.get('/receivables.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/receivables.html', import.meta.url))));
  // B-B1（2026-09-16 主动运行时 S1）：挂载 alertEndpoints 8 端点（ALERT_ENDPOINTS 权威清单）
  {
    const alertHandlers = buildAlertHandlers();
    app.get('/api/alerts', (req, res) => res.json(alertHandlers.list({ kind: req.query.kind, status: req.query.status })));
    app.post('/api/alerts/:id/ack', (req, res) => res.json(alertHandlers.ack(req.params.id)));
    app.post('/api/alerts/:id/close', (req, res) => res.json(alertHandlers.close(req.params.id, { reason: req.body?.reason })));
    app.get('/api/alerts/rules', (req, res) => res.json(alertHandlers.rules()));
    app.post('/api/alerts/rules/:kind/enable', (req, res) => res.json(alertHandlers.setRule(req.params.kind, 'enable')));
    app.post('/api/alerts/rules/:kind/disable', (req, res) => res.json(alertHandlers.setRule(req.params.kind, 'disable')));
    app.post('/api/alerts/evaluate', (req, res) => res.json(alertHandlers.evaluate({ rule: req.body?.rule, event: req.body?.event })));
    app.get('/api/feedback/metrics', (req, res) => res.json(alertHandlers.feedbackMetrics()));
  }
  // 信号端点（2026-09-16 主动运行时 S1）：列表/确认（ack=acked）/否决（close=closed）——写 crm.signal，经 scopeTenant 隔离
  //   ⚠ 2026-09-16 修正：原实现把 {id:...} 传给 scopeTenant（其读 me.tenantId）→ 恒回落 'system'（登录用户看不到本租户信号）；
  //     且未鉴权（未登录可读写 system）、severity 筛选未接（页面筛选项点了无反应）。此处对齐 /api/lead-pool 范式。
  {
    const signalStore = createSignalStore(pool);
    const adoption = createAdoption({ signalStore, writeOutcome }); // T18 采纳/否决（第 0 闸）
    const requireMe = (req, res) => {
      const me = resolveMe(req);
      if (!me?.ok) { res.status(401).json({ error: '未登录' }); return null; }
      return me;
    };
    // 读：admin/sysadmin 通配 '*'（全量，store.list 显式处理）或 ?tenant 显式收窄；普通用户自身租户
    app.get('/api/signals', async (req, res) => {
      const me = requireMe(req, res);
      if (!me) return;
      try {
        const items = await signalStore.list({
          tenant_id: applyTenantOverride(req, me),
          status: req.query.status,
          kind: req.query.kind,
          severity: req.query.severity,
        });
        res.json({ items });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // 写：scopeOf（永不通配——写不跨租户铁律；admin 也写自身所属租户）
    app.post('/api/signals/:id/ack', async (req, res) => {
      const me = requireMe(req, res);
      if (!me) return;
      try {
        const r = await signalStore.setStatus(scopeOf(me), req.params.id, 'acked');
        res.json(r.ok ? { ok: true, signal: r.alert } : { ok: false, error: r.error });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/signals/:id/close', async (req, res) => {
      const me = requireMe(req, res);
      if (!me) return;
      try {
        const r = await signalStore.setStatus(scopeOf(me), req.params.id, 'closed', { reason: req.body?.reason });
        res.json(r.ok ? { ok: true, signal: r.alert } : { ok: false, error: r.error });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // T18 采纳：必带 decision_id（第 0 闸）→ signal='acted' + 写 crm.decision_outcome；action 执行由调用方既有 Action 完成
    app.post('/api/signals/:id/adopt', async (req, res) => {
      const me = requireMe(req, res);
      if (!me) return;
      const { decision_id, suggested_action } = req.body || {};
      if (!decision_id) return res.status(400).json({ ok: false, error: 'decision_required' });
      try {
        const r = await adoption.adopt({ signal_id: req.params.id, tenant_id: scopeOf(me), actor: me.username, decision_id, suggestedAction: suggested_action });
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // T18 否决：必带 decision_id → 写 crm.decision_outcome(source='suggestion-reject') + signal 关闭
    app.post('/api/signals/:id/reject', async (req, res) => {
      const me = requireMe(req, res);
      if (!me) return;
      const { decision_id, reason } = req.body || {};
      if (!decision_id) return res.status(400).json({ ok: false, error: 'decision_required' });
      try {
        const r = await adoption.reject({ signal_id: req.params.id, tenant_id: scopeOf(me), actor: me.username, decision_id, reason });
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }
  app.get('/finance-receivables.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/finance-receivables.html', import.meta.url))));
  // 多租户计费看板页（T6）：全员可见；租户隔离在 API 层（applyTenantOverride/scopeTenant）强制本租户
  app.get('/billing.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/billing.html', import.meta.url))));
  // T13：线索发现工作台页（前台只读面；候选池经 /api/discovery/candidates，数据由 API 层租户隔离）
  app.get('/discovery.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/discovery.html', import.meta.url))));
  // 平台计费控制台（租户订阅计划 T5）：admin/sysadmin 管理面（页面 JS guard + API isPrivileged 双保险）
  // no-store：禁用浏览器启发式缓存，避免 admin 改完前端后旧 HTML 仍被缓存（2026-09-10 修复）
  app.get('/admin-billing-console.html', (req, res) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(fileURLToPath(new URL('../web/admin-billing-console.html', import.meta.url)));
  });
  // S13：指名客户目标指标配置页（sendFile 实时读 src/web）
  app.get('/named-account-targets.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/named-account-targets.html', import.meta.url))));
  // S-method-behavior-standard：销售行为标准配置页（sendFile 实时读 src/web）
  app.get('/behavior-standard-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/behavior-standard-config.html', import.meta.url))));
  // 判定阈值配置页（配置中心 id32；业务数值不硬编码，客户可按需调整）
  app.get('/sales-thresholds-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/sales-thresholds-config.html', import.meta.url))));
  // 租户级知识管理页（P0-② 领域 Know-How：ICP/竞品/异议/买家语言；写经 crm-knowledge-upsert 第0闸+confirm）
  app.get('/knowledge-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/knowledge-config.html', import.meta.url))));
  // 审批业务参数配置页（配置中心 id34；R1-R4/金额档位/角色链/默认兜底经 /api/config/approval-config 读写）
  app.get('/approval-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/approval-config.html', import.meta.url))));
  // 事件触发复盘配置页（配置中心 id35；总开关/触发分级/冷却窗经 /api/config/event-retro 读写）
  app.get('/event-retro-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/event-retro-config.html', import.meta.url))));
  // 夜间批量复盘配置页（配置中心 id43 / R3 登记；阈值经 /api/config/decision-retro 读写，写经决策第0闸+sysadmin）
  app.get('/nightly-retro-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/nightly-retro-config.html', import.meta.url))));
  // 公海池明细页（T5）：S0 待领取线索列表 + 认领闭环；页面 JS 负责拉 /api/lead-pool 与 /api/lead-pool/:id/pick
  app.get('/lead-pool.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/lead-pool.html', import.meta.url))));
  // 信号中心页（主动运行时 S1，2026-09-16）：统一信号收口 crm.signal 明细 + 确认/否决
  //   ⚠ 本仓页面**无通配 html 路由**，逐条显式注册；漏注册 = 菜单点开 404（单测只读文件内容，测不出）
  app.get('/signal-center.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/signal-center.html', import.meta.url))));
  app.get('/signal-center', (req, res) => res.redirect('/signal-center.html'));
  // 租户管理页（T8：crm.tenants 列表含创建者列 + 按创建者筛选；经 /api/tenants?createdBy= 读写，角色闸在 tenantRouter.js）
  app.get('/tenant-management.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/tenant-management.html', import.meta.url))));
  app.get('/funnel-quality.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/funnel-quality.html', import.meta.url))));
  // 参数传播中枢页（继承 / 强制下发 / 上行推广；API 在 propagationRoutes.js，全经决策第0闸）
  app.get('/propagation-hub.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/propagation-hub.html', import.meta.url))));
  // ─── S13 指名客户监测看板端点（§12.3 + §12.3bis + §13.3）───
  // 契约：GET /api/board/named-accounts?owner=&includeUnassigned= → { rows, count, owner, summary, unassigned? }
  //   includeUnassigned=1 仅 admin/manager 生效：返回无主户分桶（named_owner 空）→ 引导管理页分配
  // 角色：sales/manager/admin 均可见本人（manager 可按 ?owner= 切团队成员视角）
  app.get('/api/board/named-accounts', async (req, res) => {
    try {
      let me;
      try { me = await resolveMe(req); } catch { me = { ok: false }; }
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      // owner 语义：显式 ?owner=（manager 切人）> me.username（当前登录用户名）> null（全部）
      // 注：account payload.owner 存 username（业务口径），不用 person slug（resolveActor 映射的是 slug）
      const ownerFilter = req.query.owner || me.username || null;
      const tid = applyTenantOverride(req, me); // admin 可经 ?tenant= 收窄到单租户；普通用户恒自身租户
      const [accounts, deals, contracts, contacts] = await Promise.all([
        queryParticles({ type: 'CRM_ACCOUNT', tenantId: tid, limit: 100 }).catch(() => []),
        queryParticles({ type: 'CRM_DEAL', tenantId: tid, limit: 200 }).catch(() => []),
        queryParticles({ type: 'CRM_CONTRACT', tenantId: tid, limit: 100 }).catch(() => []),
        queryParticles({ type: 'CRM_CONTACT', tenantId: tid, limit: 200 }).catch(() => []),
      ]);
      const targetsCfg = mergedTargets(await readTenantConfig('named-account-targets', me));
      const behaviorStd = mergedBehaviorStd(await readTenantConfig('behavior-standard', me));
      // 判定阈值（config_store['sales-thresholds']，配置中心 id32；业务数值不硬编码）
      const thresholds = mergedThresholds(await readTenantConfig('sales-thresholds', me));
      const rows = buildNamedAccountBoard({ accounts, deals, contracts, targetsCfg, ownerFilter, contacts, thresholds });
      const summary = boardSummary(accounts, deals, contracts, targetsCfg, ownerFilter, contacts, behaviorStd, thresholds);
      // §5 防呆（原方案 B）：暴露"未正确归属"的商机（孤儿/错绑），供前端预警、不改主数据
      const orphans = listOrphanDeals(accounts, deals);
      // 2026-08-31 根因修复：admin/manager 视角 ?includeUnassigned=1 返回无主户分桶（无名主户的潜在账户）
      // 目的：让 admin 立刻能发现"被 AI 写了但忘了 named_owner"的账户，导流到 named-account-manage 分配
      let unassigned = null;
      const wantUnassigned = String(req.query.includeUnassigned || '') === '1';
      if (wantUnassigned && (me.role === 'admin' || me.role === 'manager' || me.role === 'sysadmin')) {
        // 2026-08-31 root cause fix：listUnassignedAccounts 纯函数（src/sales/namedAccountBoard.js:101+）
        //   命名与 namedAccountAssign options 同源（named_owner/owner_id/owner 三键全空过滤）
        const unassignedRows = listUnassignedAccounts(accounts);
        unassigned = { count: unassignedRows.length, rows: unassignedRows };
      }
      res.json({ rows, count: rows.length, owner: ownerFilter, summary, unassigned, orphans });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  // S13：指名客户监测看板页（sendFile 实时读 src/web）
  app.get('/named-accounts.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/named-accounts.html', import.meta.url))));
  // ─── 指名客户管理聚合端点（设计 2026-08-30 §3；Task5）───
  // 契约：GET /api/board/named-account-manage?owner= → { rows, count, owner, summary, alertRed, alertYellow, followReminders, lostContactCount }
  // rows 行字段：id/name/owner/tier/visitTarget/visitWindow/visits30/visitPass/named/alert/overdueDays/visitDue/lostContact/lastContactDays
  // 告警统计：alertRed（应访未访红）/ alertYellow（临近黄）——Task8 三区页 KPI 卡；与看板同源（buildNamedAccountBoard + namedVisitStatus）
  // 角标统计：followReminders（逾期红 ∪ 长期失联，去重）/ lostContactCount —— 侧栏「客户跟踪」角标数据源（设计 2026-08-31 §1.2）
  app.get('/api/board/named-account-manage', async (req, res) => {
    try {
      let me;
      try { me = await resolveMe(req); } catch { me = { ok: false }; }
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      // owner 语义：管理页角色（admin/manager）默认全量（管理视角）；sales 默认本人；显式 ?owner= 优先
      const ownerFilter = req.query.owner || (!['admin', 'manager'].includes(me.role) ? me.username : null) || null;
      const tid = applyTenantOverride(req, me); // admin 可经 ?tenant= 收窄到单租户；普通用户恒自身租户
      const [accounts, deals, contracts, contacts] = await Promise.all([
        queryParticles({ type: 'CRM_ACCOUNT', tenantId: tid, limit: 200 }).catch(() => []),
        queryParticles({ type: 'CRM_DEAL', tenantId: tid, limit: 200 }).catch(() => []),
        queryParticles({ type: 'CRM_CONTRACT', tenantId: tid, limit: 100 }).catch(() => []),
        queryParticles({ type: 'CRM_CONTACT', tenantId: tid, limit: 200 }).catch(() => []),
      ]);
      const targetsCfg = mergedTargets(await readTenantConfig('named-account-targets', me));
      const behaviorStd = mergedBehaviorStd(await readTenantConfig('behavior-standard', me));
      const thresholds = mergedThresholds(await readTenantConfig('sales-thresholds', me));
      const rows = buildNamedAccountBoard({ accounts, deals, contracts, targetsCfg, ownerFilter, contacts, thresholds });
      const summary = boardSummary(accounts, deals, contracts, targetsCfg, ownerFilter, contacts, behaviorStd, thresholds);
      // 告警统计（复用 namedVisitStatus 口径：窗口内未达标才看逾期红/黄——达标自动绿）
      const alertRed = rows.filter(r => r.alert === 'red').length;
      const alertYellow = rows.filter(r => r.alert === 'yellow').length;
      // 侧栏「客户跟踪」角标数据源（2026-08-31）：逾期红 ∪ 长期失联（≥coverage.lost_contact_days）
      // 去重语义：同一客户既逾期又失联时只计 1（非 alertRed + lostContactCount 简单相加）
      const followReminders = rows.filter(r => r.alert === 'red' || r.lostContact).length;
      const lostContactCount = rows.filter(r => r.lostContact).length;
      res.json({
        rows, count: rows.length, owner: ownerFilter, summary,
        alertRed, alertYellow,
        followReminders, lostContactCount,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  // L1 销售个人行为看板页（复用 /api/board/named-accounts?owner=me）
  app.get('/sales-behavior-board.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/sales-behavior-board.html', import.meta.url))));
  // 决策质量校准（2026-08-28 校准闭环；metrics/patches/replay + approve/reject/rollback，全部 sysadmin + 第0闸）
  app.use(createCalibrationRouter());
  // 监控台契约消费（living contract）：GET 公开（对齐 /api/agents）；POST sysadmin 闸；绝对禁删
  app.use(createContractRouter());
  // 业务分级配置（第 18 项，驱动自主边界）
  app.use(createBusinessTierRouter({}));
  app.use(createRbacRouter({}));
  // 销售决策场景配置（第 14 项；管理 crm.decision_scenario，写经决策第0闸 + 字段白名单）
  // G5（2026-09-05）决策场景配置端点：读按 scopeTenant(me)、写按 scopeOf(me)
  app.use(createDecisionScenarioRouter({ resolveMe }));
  // 用户管理配置（第 12 项；管理 crm.crm_users，写经决策第0闸 + sysadmin 权限 + 绝对禁删）
  app.use(createUserRouter({}));
  // 粒子模型/本体/词汇配置（第 22 项；词汇同源 CRM_KNOWLEDGE 粒子 + 决策第0闸 + sysadmin + 词汇软停用禁删）
  app.use(createOntologyRouter({}));
  // 系统设置配置（第 28 项；管理 crm.config_store key='system'，写经决策第0闸 + sysadmin，审计直查 decision_event）
  app.use(createSystemSettingsRouter({}));
  app.use(createMemoryConfigRouter({}));
  // 审批流配置（第 17 项；管理 crm.approval_flow，写经决策第0闸）
  app.use(createApprovalFlowRouter({}));
  // 预警规则配置（第 21 项；管理 crm.alert_rule，写经决策第0闸 + 启动水合）
  app.use(createAlertRuleConfigRouter({}));
  // 连接器/MCP 身份配置（第 27 项；管理 crm.mcp_identity，零信任 token 哈希，绝对禁删）
  // 注入 resolveMe：个人 me/mine 端点依赖（与 createDecisionScenarioRouter 同款 DI 模式）
  app.use(createMcpIdentityRouter({ resolveMe }));
  app.use(createAgentConfigRouter({ getSpecs: async () => agentSpecs, getAssembly: assertAgentAssembly }));
  // 外部采集手动同步端点（方案 A）：工商校验等写通道，admin/sysadmin 闸
  app.use('/api/connector', createConnectorRouter({ resolveMe }));
  // 方法论 SKILL 注册表（第 16 项；管理 skill_registry 启停，GET 快照 + PUT 写经第0闸+sysadmin+禁删只改 enabled）
  app.use(createSkillRegistryRouter({}));
  // 受控配置页工厂（S17/S19/S23/S24：/api/page/users|decision-scenarios|business-tier|meta-attr）
  // 只读视图，与手写管理页并存；写仍走各自 Router 第0闸
  app.use(createControlledPagesRouter({}));
  // 写通道依赖 Action Registry：建应用时幂等注入（registerAction 用 Map.set，重复安全）
  seedActions();
  // ④ 外部连接器 P0：ATTIO enrichment + 工商校验（autoDecision 过第 0 闸，auto_weak 来源边）
  seedConnectorActions();
  // 线索自主发现 Action 族（Task 5 硬闭包 1/3）：与 agents.js 同源，两条注册入口都须接线
  seedDiscoveryActions();
  // 线索发现内置适配器（Task 7 死接线修复）：适配器自注册但注册表刻意不 import 适配器，
  // 缺此显式汇聚 → REGISTRY 恒空 → enrich 静默零产出。启动点 import 一次即可（ESM 单例幂等）。
  registerBuiltinAdapters();
  // 记忆治理底座：事件总线单汇点捕获（residue 零摩擦），建应用时注册一次
  registerCaptureSubscriber();
  // C4（2026-09-10）：捕获域白名单可由 config_store['memory-capture-domains'] 覆盖；
  //   无配置/读取失败 → 保持代码内缺省白名单（绝不因配置异常放开全量订阅）。
  loadCaptureDomains().catch(() => {});
  // 销售决策监控：monitor_event 表 + decision 事件域订阅（异常隔离不阻断写），建应用时注册一次
  ensureMonitorSchema().then(() => registerMonitorSubscriber()).catch((e) => console.error('[routes] monitor schema:', e?.message));
  // ③ 定时规则驱动：nightly 蒸馏 24h + crm-risk 扫描 30min（幂等单例，防双实例）
  ensureTimers({}).catch(() => {});
  // 预警规则持久源水合：从 crm.alert_rule 回填内存缓存（PG 不可用则回退 DEFAULT_RULES）
  hydrateAlertRules().catch(() => {});

  // 读直连（默认）
  app.get('/api/particles', async (req, res) => {
    const me = resolveMe(req);
    const { type } = req.query;
    // 业务主数据软停用默认过滤：停用态不在默认列表出现；?includeInactive=1 可查看全部。
    // 各类型停用态不同：产品=discontinued；价格表/规则包/回款政策=expired；字典=deprecated。
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const DEFAULT_EXCLUDE = {
      CRM_PRODUCT: ['discontinued'],
      CRM_PRICE_LIST: ['expired'],
      CRM_OFFER_POLICY: ['expired'],
      CRM_DICT_ENTRY: ['deprecated'],
    };
    const excludeStates = includeInactive ? null : (DEFAULT_EXCLUDE[type] || null);
    const items = await queryParticles({ type: type || null, tenantId: applyTenantOverride(req, me), limit: 100, excludeStates });
    res.json({ items });
  });

  // 粒子属性元模型（G1 T6）：读直连桥接（元模型受控组件/抽屉消费；写走 data-particle-attr-update 第 0 闸）
  app.get('/api/meta-attr', async (req, res) => {
    try {
      const { type } = req.query;
      const items = await listMetaAttr({ particleType: type || null });
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 粒子详情受控 Schema（S13 面：detail 型 schema，attr-field 四查徽标 + subtable；?schema=1 返回 schema 形态）
  // Phase 2 Task 8：复用 buildParticleDetailSchema 纯函数；无 schema 参数则返回既有 detail 对象
  app.get('/api/particles/:id/schema', async (req, res) => {
    try {
      const me = resolveMe(req);
      const particle = await getParticle(req.params.id); // 按 id 精确命中（queryParticles 忽略 id 过滤）
      if (!particle) return res.status(404).json({ error: 'particle not found' });
      const [{ rows: outEdges }] = await Promise.all([
        query(`SELECT edge_type, target_type, target_id, meta FROM crm.edges WHERE tenant_id=$1 AND source_id=$2`, [scopeTenant(me), req.params.id]),
      ]);
      const targets = outEdges.length
        ? (await query(`SELECT * FROM crm.particles WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [scopeTenant(me), outEdges.map(e => e.target_id)])).rows
        : [];
      const detail = buildParticleDetail(particle, outEdges, targets);
      const r = buildParticleDetailSchema(detail);
      if (!r.ok) return res.status(500).json({ error: r.errors[0] });
      res.json({ schema: r.schema });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  // 字段级审计历史（P1③，docs/2026-09-05-security-hardening-design.md §3.3）：
  // 查 crm.audit_event.payload 投影 field/before/after + actor + decision_id；价格字段 list_price 起步（YAGNI）
  app.get('/api/particles/:id/field-history', async (req, res) => {
    const { id } = req.params;
    const { field } = req.query;
    if (!field) return res.status(400).json({ error: 'field 必填' });
    try {
      // 越权谓词：data_scope 外的粒子不可看字段历史（复用 P0① scopePredicateFor；越权 403 fail-closed）
      const me = resolveMe(req);
      const actor = me?.ok && me.username ? await resolveActor(me.username).catch(() => null) : null;
      const profile = me?.ok && me.role ? await loadProfile(me.role).catch(() => null) : null;
      const sc = await scopePredicateFor(profile, actor).catch(() => ({ clause: '', params: [] }));
      if (sc.clause) {
        const vis = await query(`SELECT 1 FROM crm.particles p WHERE p.id = $1${sc.clause} LIMIT 1`, [id, ...sc.params]);
        if (!vis?.rows?.length) {
          emit('trace', 'field-history-scope-excluded', { particle_id: id, field, actor });
          return res.status(403).json({ error: 'scope-excluded' });
        }
      }
      const r = await query(
        `SELECT payload, actor, decision_id, created_at FROM crm.audit_event
         WHERE payload->>'particle_id'=$1 AND payload->>'field'=$2
         ORDER BY created_at`,
        [id, field]
      );
      // fail-open 读失败返回空（禁裸 catch：留痕）
      const rows = (r && r.rows) || [];
      res.json({ field, events: projectFieldHistory(rows, field) });
    } catch (e) {
      emit('trace', 'field-history-read-failed', { particle_id: id, field, error: String(e?.message || e) });
      res.json({ field, events: [] });
    }
  });
  app.get('/api/particles/:id', async (req, res) => {
    try {
      const me = resolveMe(req);
      const particle = await getParticle(req.params.id); // 按 id 精确命中（queryParticles 忽略 id 过滤）
      if (!particle) return res.status(404).json({ error: 'particle not found' });
      // 出边（含 sourcedFrom/auto_weak 来源语义边，meta 透传 relation_confidence）
      const [{ rows: outEdges }] = await Promise.all([
        query(`SELECT edge_type, target_type, target_id, meta FROM crm.edges WHERE tenant_id=$1 AND source_id=$2`, [scopeTenant(me), req.params.id]),
      ]);
      // 关联实体名（详情页展示来源链路与关联）
      const targets = outEdges.length
        ? (await query(`SELECT * FROM crm.particles WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [scopeTenant(me), outEdges.map(e => e.target_id)])).rows
        : [];
      res.json(buildParticleDetail(particle, outEdges, targets));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 写通道（Task 3 改造：去掉 bootstrap 旁路 → 真实第 0 闸）
  // 决策映射：新建商机（stage=lead）=「新线索跟不跟」→ LEAD_FOLLOW_UP（决策场景字典 8 场景唯一事实源 db/seed.sql:226-268；
  //   default_tier=LEAD；无先例→保守升级 HITL（403，产出 HUMAN 态决策供审批流消费），有人工确认先例后同类方可自主放行（201））
  //   （2026-08-28 设计裁定：扭转此前「低位场景无条件自主放行」）
  // 非 DEAL（CRM_ACCOUNT 等）：业务分级不适用（DEAL=客户×项目维），直接经 executor 写（仍走其余各闸）
  app.post('/api/particles', async (req, res) => {
    const { type, payload } = req.body || {};
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' }); // 无认证一律 401
      const ctx = { tenantId: scopeOf(me), actor: me.username || me.display_name || 'user', role: me.role };
      // 系统引导/种子通道：x-crm-bootstrap 头显式声明（⌘K NL 录入 / 引导建档）→ 豁免第0闸（不绕 stage 白名单）
      // 普通页面表单录入无此头 → 经 requireDecision 第0闸（无先例升级人工，审批流消费）
      if (req.headers['x-crm-bootstrap'] === '1') ctx.bootstrap = true;
      // 2026-08-31 根因修复：CRM_ACCOUNT 写路径强约束 named_owner（AI/页面写账户无主→指名看板不可见）
      // 非 bootstrap 通道（对话式 + 表单录入）→ enforce；bootstrap（系统种子/迁移）→ 放行
      if (type === 'CRM_ACCOUNT' && !ctx.bootstrap) ctx.enforceNamedOwner = true;
      // 输入校验前置：DEAL 六段白名单（拒 leads 脏值；缺省兜底 lead）——在任何引擎/写库前拦截（400，非 403）
      if (type === 'CRM_DEAL') normalizeStage(type, payload);
      if (!ctx.bootstrap) {
        // 第 0 闸（对齐 configRouter.produceDecision 先例）：写无决策不落库
        //  DEAL → LEAD_FOLLOW_UP 真判定（升级 403，审批流消费）；非 DEAL/未知场景 → 降级记录事件不硬抛
        let decisionId = null;
        if (type === 'CRM_DEAL') {
          const dec = await requireDecision(
            'LEAD_FOLLOW_UP', { customer: payload?.customer_tier, project: payload?.project_tier, ...(payload || {}), actor: ctx.actor }, [{ type, id: null }]
          ).catch((e) => ({ mode: 'error', error: e.message }));
          if (!dec || dec.mode === 'error') return res.status(500).json({ error: dec?.error || '决策引擎异常' });
          if (dec.mode === 'escalated' || dec.decision?.state !== 'AUTONOMOUS') {
            // 校准 P0：升级决策落地为待办（携带 decision_id），使人工处置可回写 → 采集覆写信号
            //   fail-open：建待办失败不阻断主流程，仍返回 403（第0闸语义不变）
            await createTask({
              step: 'decision-review',
              title: `决策审批：${type} · ${dec.decision?.scenario_id || 'LEAD_FOLLOW_UP'}`,
              actionName: 'decision-disposition',
              payload: { type, payload },
              decisionId: dec.decision?.decision_id || null,
            }).catch(() => {});
            return res.status(403).json({
              error: '写操作需自主决策上下文（第0闸）：该商机分级升级人工，请经审批流发起',
              decision: dec.decision?.decision_id || null, tier: dec.tier || null,
            });
          }
          decisionId = dec.decision.decision_id;
        } else {
          // 非 DEAL（ACCOUNT/CONTACT/PRODUCT…客户建档/基础数据）：无销售决策场景（LEAD_FOLLOW_UP 仅 DEAL）；
          //   → 系统引导数据录入语义（等同 bootstrap 豁免第0闸，对齐 decision-gate.test.js:18 bootstrap 先例）
          //   + 落决策事件审计链（configRouter.produceDecision 降级先例：不硬抛、写继续）
          ctx.bootstrap = true;
          await recordDecisionEvent('config_change', { scenario_id: 'particle-create-non-deal', type, trigger_context: payload }).catch(() => {});
        }
        ctx.decision_id = decisionId || null;
      }
      const r = await actionExecutor.dispatch('data-particle-create', { type, payload }, ctx);
      if (!r.ok) return res.status(400).json({ error: r.error, gate: r.gate, decision: ctx.decision_id || null });
      // Plan B（2026-09-03 根治）：决策先于粒子落库（第0闸），involved_entities.id 初为 null；
      //   粒子落库后回填真实粒子 id，使未来决策可被 query 按 e->>'id' 直接命中（fail-open 不阻断主写）。
      if (ctx.decision_id && type === 'CRM_DEAL' && r.data?.id) {
        await backfillDecisionInvolvedEntity(ctx.decision_id, r.data.id, type).catch(() => {});
      }
      res.status(201).json({ particle: r.data, decision: ctx.decision_id || null, confirm: 'stage2' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 看板（编排数据同源：直接读 tasks 表）
  app.get('/api/kanban/tasks', async (req, res) => {
    const me = resolveMe(req);
    const { status, chainId } = req.query;
    const items = await listTasks({ status: status || null, chainId: chainId || null, tenantId: scopeTenant(me) });
    res.json({ items });
  });

  app.post('/api/kanban/tasks/:id/reset', async (req, res) => {
    const t = await resetTask(req.params.id, { byActor: 'admin', reason: 'manual_unblock' });
    res.json({ task: t });
  });

  app.post('/api/kanban/pump', async (req, res) => {
    const n = await pumpReadyTasks({});
    res.json({ dispatched: n });
  });

  // 智能体调度入口（S03 工作台 goal-form 重定向目标）
  // 接收自然语言需求 → 分类 → 落 kanban 任务 → 显式泵起（弥补无自动泵循环）
  // 注意：dispatch 创建的是编排任务（crm.kanban.tasks），非业务粒子写，不触发 requireDecision 硬闸；
  //   仅经 recordDecisionEvent 落决策审计链（降级不硬抛，对齐非 DEAL 粒子写范式）。
  app.post('/api/agent/dispatch', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ ok: false, error: me?.error || 'unauthorized' });
    const nl = String(req.body?.requirement || req.body?.nl || '').trim();
    if (!nl) return res.status(400).json({ ok: false, error: 'requirement_required' });
    const cls = classifyRequirement(nl);
    if (cls.needsClarification) {
      return res.status(422).json({ ok: false, error: 'needs_clarification', needsClarification: true, notes: cls.notes });
    }
    // 精确绑定（Buddy 门户外壳透传）：skillSlug/targetAgent 经 routeThroughIntake 原样保留
    // （仅当 skillSlug 落在目标 agent 的 skillCalls 闭包内；否则回落 primarySkillFor，不影响重大商机闸门）。
    const skillSlug = typeof req.body?.skillSlug === 'string' && req.body.skillSlug ? req.body.skillSlug : null;
    const targetAgent = typeof req.body?.targetAgent === 'string' && req.body.targetAgent ? req.body.targetAgent : null;
    await recordDecisionEvent('agent_dispatch', {
      scenario_id: 'agent-dispatch', intent: cls.intent, level: cls.level, actor: me.username, requirement: nl,
    }).catch(() => {});
    const task = await createTask({
      step: 'agent-dispatch',
      title: nl.slice(0, 80),
      actionName: 'agent-dispatch',
      payload: { requirement: nl, intent: cls.intent, level: cls.level, skill_slug: skillSlug, targetAgent, owner: me.username },
      decisionId: null,
    });
    // 弥补无自动泵循环：创建后显式泵起，使 agent_loop 自然消费（routeThroughIntake → runWithSkill）
    const dispatched = await pumpReadyTasks({}).catch(() => 0);
    emit('task', 'created', { id: task.id, taskId: task.id, intent: cls.intent, level: cls.level, status: task.status });
    return res.json({ ok: true, taskId: task.id, intent: cls.intent, level: cls.level, status: task.status, dispatched });
  });

  // 装配校验 + 3 Agent 状态 + specs 摘要（监控台用，避免前端硬编码）
  app.get('/api/agents', async (req, res) => {
    const asm = await assertAgentAssembly();
    res.json({
      agents: Object.keys(agentSpecs),
      assembly: asm,
      specs: Object.fromEntries(Object.entries(agentSpecs).map(([id, s]) => [id, {
        name: s.identity.name,
        derivedFrom: s.identity.derivedFrom,
        autonomy: s.identity.autonomy,
        actionCount: s.capabilities.actions.length,
        skillCallCount: s.capabilities.skillCalls.length,
        actions: s.capabilities.actions,
        skillCalls: s.capabilities.skillCalls,
      }])),
    });
  });

  app.get('/api/realtime/health', async (req, res) => {
    res.json({ ok: true, ts: Date.now(), domains: ['task', 'trace', 'approval', 'particle', 'payment', 'decision'] });
  });

  // ── 真实登录认证（v2 门户：Home.html → token → index.html）──
  app.post('/api/auth/login', async (req, res) => {
    const r = await login(req.body || {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.status(r.status).json({ token: r.token, role: r.role, display_name: r.display_name });
  });
  app.get('/api/auth/me', async (req, res) => {
    const r = resolveMe(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ role: r.role, display_name: r.display_name, username: r.username });
  });

  // 自助注册（公开端点）：根据公司名称自动判定租户（不存在则开通）；首注册者=租户 admin
  app.post('/api/auth/register', handleRegister);
  // 自助注册激活闭环：激活 / 重发激活码（注册后须先激活再登录）
  app.post('/api/auth/activate', handleActivate);
  app.post('/api/auth/resend-code', handleResend);

  // ─── 阶段3 池配置（T3-12：池规则读写，不重启生效）───
  // 2026-09-05 G4：读按 scopeTenant(me)（admin '*' → system 视界），写按 scopeOf(me)（永不通配，admin 写自身租户）
  // 2026-09-11 T5：真源迁 crm.config_store['lead-pool-config']（三类池 new/nurture/lost，per-tenant）。
  //   读：config（新形态）+ legacy（旧组织粒子，兼容读）+ seeded（是否克隆自平台模板）。
  //   写：pools 数组按池 id 合并（字段经 validatePoolPatch 白名单+边界校验，防写引擎不认的键）；
  //       patch 旧形态保留（向后兼容既有调用方）。
  app.get('/api/pool-config', async (req, res) => {
    try {
      const me = resolveMe(req);
      const { orgId = 'org-hq' } = req.query;
      const tenantId = scopeTenant(me && me.ok ? me : null);
      const config = await readPoolConfig({ tenantId });
      const legacy = await getPoolConfig(orgId, { tenantId }).catch(() => null);
      res.json({ orgId, tenantId, config, legacy, seeded: Boolean(config._seeded) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.put('/api/pool-config', async (req, res) => {
    try {
      const me = resolveMe(req);
      const { orgId = 'org-hq', patch, pools } = req.body || {};
      const tenantId = scopeOf(me && me.ok ? me : null);
      if (Array.isArray(pools)) {
        const { validatePoolPatch } = await import('../portal/poolConfigRender.js');
        const cfg = await readPoolConfig({ tenantId });
        const nextPools = cfg.pools.map((p) => {
          const hit = pools.find((x) => x.id === p.id);
          if (!hit) return p;
          const pr = validatePoolPatch(hit.pick_rule || {});
          const rr = validatePoolPatch({ recycle_days: hit.recycle_rule?.recycle_days });
          if (!pr.ok || !rr.ok) throw new Error([...pr.errors, ...rr.errors].join('; '));
          return { ...p, pick_rule: { ...p.pick_rule, ...pr.normalized }, recycle_rule: { ...p.recycle_rule, ...rr.normalized } };
        });
        const config = await writePoolConfig({ tenantId, patch: { pools: nextPools }, updatedBy: (me && me.actor) || 'system' });
        return res.json({ orgId, tenantId, config, updated: true });
      }
      if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch 或 pools 必填' });
      const config = await setPoolConfig(orgId, patch, { tenantId });
      res.json({ orgId, config, updated: true, tenantId });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── T1 公海池明细查询（销售查看公海 S0 待领取线索 + 认领入口数据）───
  // 仅返回本租户 stage='S0'（公海、无主）的 CRM_DEAL；按入池时间倒序（pooled_at 优先，退化 created_at）。
  // 读端经 scopeTenant(me)（alice=system 租户 → 仅见 system 租户 S0）；写端 pick 才是 fail-closed（P1-1 残余，见下）。
  app.get('/api/lead-pool', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const tenantId = scopeTenant(me);
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500); // 默认 100（设计 §3.1：截断提示防假绿）
      // 总数（不受 limit 影响，杜绝假绿）
      const totalRes = await query(
        `SELECT count(*)::int AS n FROM crm.particles WHERE tenant_id=$1 AND type='CRM_DEAL' AND payload->>'stage'='S0'`,
        [tenantId]
      );
      const total = totalRes.rows[0]?.n || 0;
      const r = await query(
        `SELECT id, title, payload, created_at FROM crm.particles
         WHERE tenant_id = $1 AND type = 'CRM_DEAL' AND payload->>'stage' = 'S0'
         ORDER BY coalesce(NULLIF(payload->>'pooled_at','')::timestamptz, created_at) DESC
         LIMIT $2`,
        [tenantId, limit]
      );
      const now = Date.now();
      const items = r.rows.map((row) => {
        const p = row.payload || {};
        // in_pool_days 兜底链：pooled_at → returned_at → created_at（设计 §6，恒为数字，杜绝假绿）
        const anchor = p.pooled_at || p.returned_at || (row.created_at ? String(row.created_at) : null);
        let inPoolDays = 0;
        if (anchor) {
          const t = new Date(anchor).getTime();
          if (!Number.isNaN(t)) inPoolDays = Math.max(0, Math.floor((now - t) / 86400000));
        }
        // P0-1c（2026-09-15）：信号新鲜度——取 payload.signals（发现侧数组，元素 {type,provider,ts}）
        //   各 ts 的最小年龄 → 分档 hot(≤7d)/warm(≤30d)/stale(>30d)；无信号 → unknown。
        //   阈值与 signalFreshness.DEFAULT_AGE_TIERS 同源（7/30）；配置化衰减详见评分侧（P0-1b）。
        let freshness = 'unknown';
        const sigs = Array.isArray(p.signals) ? p.signals : [];
        const sigAges = sigs
          .map((s) => (s && s.ts ? new Date(s.ts).getTime() : NaN))
          .filter((t) => !Number.isNaN(t))
          .map((t) => Math.max(0, Math.floor((now - t) / 86400000)));
        if (sigAges.length) {
          const minAge = Math.min(...sigAges);
          freshness = minAge <= 7 ? 'hot' : (minAge <= 30 ? 'warm' : 'stale');
        }
        return {
          id: row.id,
          name: p.name || row.title || '',
          source: p.source || p.source_type || null,
          pool_type: p.pool_type || null,
          amount: (p.amount ?? p.expected_amount ?? null),
          owner_id: p.owner_id || null,
          pooled_at: p.pooled_at || null,
          in_pool_days: inPoolDays,
          freshness,
        };
      });
      // 池规则（按租户读 config_store，缺省回退三池默认）
      let rules = { daily_limit: 10, pick_interval_hours: 24, new_data_only: false, prev_owner_only: false };
      try {
        const cfg = await readPoolConfig({ tenantId });
        const pn = (cfg.pools || []).find((x) => x.id === 'pool-new') || cfg.pools?.[0] || {};
        const pr = pn?.pick_rule || {};
        rules = {
          daily_limit: typeof pr.daily_limit === 'number' ? pr.daily_limit : 10,
          pick_interval_hours: pr.pick_interval_hours ?? 24,
          new_data_only: !!pr.new_data_only,
          prev_owner_only: !!pr.prev_owner_only,
        };
      } catch { /* 用默认规则 */ }
      // 我的今日认领数（复用 crm-lead-pick 同一套 agg 口径：当日 FILTER + picked_at，date_trunc('day')）
      let myPickToday = 0;
      const who = me.username || me.display_name || null;
      if (who) {
        const agg = await query(
          `SELECT count(*) FILTER (WHERE NULLIF(payload->>'picked_at','')::timestamptz >= date_trunc('day', now()))::int AS n
           FROM crm.particles
           WHERE type='CRM_DEAL' AND tenant_id=$2 AND payload->>'stage'='S0P' AND payload->>'owner_id'=$1`,
          [who, tenantId]
        ).catch(() => ({ rows: [{ n: 0 }] }));
        myPickToday = agg.rows[0]?.n || 0;
      }
      res.json({
        items, returned: items.length, total, truncated: items.length >= limit,
        rules, my_pick_today: myPickToday, my_can_pick: myPickToday < rules.daily_limit,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── T2 公海池认领（复用 crm-lead-pick；POST 写端 fail-closed，P1-1 残余）───
  app.post('/api/lead-pool/:id/pick', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      // 缺真实租户（或 platform/system 视界）→ 无法确定套餐权益（需 core_crm），fail-closed 拒绝
      if (!me.tenantId || me.tenantId === 'system') return res.status(400).json({ ok: false, gate: 'plan_entitlement_missing_tenant', error: '执行上下文缺租户（或 platform/system 视界），无法确定套餐权益（需 core_crm）' });
      const owner_id = me.username || me.display_name || 'user';
      const r = await actionExecutor.dispatch('crm-lead-pick',
        { deal_id: req.params.id, owner_id },
        { actor: owner_id, role: me.role, tenantId: me.tenantId ?? null, decision_id: null });
      if (!r.ok) return res.status(400).json({ ok: false, gate: r.gate, error: r.error });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── P0-3b：富集成本/命中率指标端点（设计 docs/2026-09-15-anysite-borrowing-analysis.md §3 P0-3）───
  // 数据源：crm.events 的 enrichment 域事件（prospectingActions confirm 段每入池一条发 enrichment-attempt）
  // 抗假绿：rate 分母 = 事件条数（真实 calls），不虚造；hits = 新落池数（非 existing）
  app.get('/api/enrichment-metrics', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const tenantId = scopeTenant(me);
      // 语义：calls = Σ(payload.calls)（累计精富集候选数，与 P0-3a aggregateEnrichment 同口径），
      //       不是 count(*)（事件条数）——一次 confirm 批量只发 1 条事件，但含多条候选。
      const r = await query(
        `SELECT COALESCE(sum((payload->>'calls')::int), 0)::int AS calls,
                COALESCE(sum((payload->>'cost')::numeric), 0)::float AS cost,
                COALESCE(sum((payload->>'hits')::int), 0)::int AS hits
         FROM crm.events WHERE domain='enrichment' AND payload->>'tenant_id'=$1`,
        [tenantId]
      );
      const row = r.rows[0] || { calls: 0, cost: 0, hits: 0 };
      const calls = row.calls || 0;
      const hits = row.hits || 0;
      res.json({
        calls, cost: row.cost || 0, hits,
        rate: calls > 0 ? hits / calls : 0,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── L2C 业务闭环看板聚合端点（富化版，对齐 docs/2026-08-28-business-closure-design.md）───
  // 富化：补 CRM_ACCOUNT + 金额映射 + 回款合并(PLAN/RECORD/INVOICE) + leadPool(DEAL-stage=lead) + total；
  // 向后兼容保留 grouped（/api/page/home 仍可用）。服务端逻辑在 businessBoard.js，渲染在 businessClosureRender.js。
  app.use(createBusinessBoardRouter({ queryParticles }));

  // ─── S14 决策图谱 受控渲染（复刻 S15：renderPage 唯一出口 + graph 三 handler 真实数据面）───
  // 契约：GET /api/page/decision-graph?decisionId= → { schema:S14, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 数据面：table「决策邻居」= traceDecision upstream+downstream 节点；subtable「溯源链」= exportAudit 的 entries；
  //         reasoning-trace「因果链」= schema 内联 steps（决策加载/关联展开/因果链）
  app.get('/api/page/decision-graph', async (req, res) => {
    let me = {};
    try { me = resolveMe(req) || {}; } catch {}
    try {
      let decisionId = req.query.decisionId;
      if (!decisionId) {
        const rows = await queryParticles({ type: 'CRM_DEAL', tenantId: scopeTenant(me), limit: 1 }).catch(() => []);
        // 决策优先取最新决策记录（无则回退到首个 DEAL 的决策链；created_at 同秒时按 decision_id 决胜保证确定性）
        // 注意：query() 返回 pg.Result，须取 .rows；原 dRows[0] 误把 Result 当下标 → 恒 undefined（仅靠 CRM_DEAL 粒子兜底，决策表回退失效）
        const dRes = await query(`SELECT decision_id FROM crm.decision ORDER BY created_at DESC, decision_id DESC LIMIT 1`).catch(() => ({ rows: [] }));
        decisionId = dRes.rows[0]?.decision_id || rows[0]?.id || null;
      }
      if (!decisionId) {
        res.status(404).json({ error: '无决策可展示', decisionId });
        return;
      }

      // 决策清单（全网概览，首个组件）：决策表 + 场景联动（description 作场景名）；决策属平台问责层默认不过滤租户
      const scRes = await query(`SELECT scenario_id, description FROM crm.decision_scenario`).catch(() => ({ rows: [] }));
      const scDesc = {};
      for (const r of (scRes.rows || [])) scDesc[r.scenario_id] = r.description || '';
      const listRows = await query(
        `SELECT decision_id, scenario_id, disposition, state, outcome, created_at
         FROM crm.decision ORDER BY created_at DESC, decision_id DESC LIMIT 30`
      ).catch(() => ({ rows: [] }));
      const decisionRows = (listRows.rows || []).map((r) => ({
        decision_id: r.decision_id,
        scenario: scDesc[r.scenario_id] || r.scenario_id,
        disposition: r.disposition,
        state: r.state,
        outcome: r.outcome || '',
        created_at: r.created_at ? String(r.created_at).slice(0, 19).replace('T', ' ') : '',
      }));

      // 真实数据面：graph 三 handler（与 /api/graph/trace|impact|provenance 同源，单一事实源）
      const { upstream = [], downstream = [] } = await graphTraceHandler(decisionId, { maxDepth: 4 });
      const audit = await graphProvenanceHandler(decisionId).catch(() => ({ entries: [], referenced_precedents: [] }));

      // 邻居节点真实字段仅 decision_id/state/disposition（AGE 顶点 RETURN 未带 scenario_id）→ 批量回查决策表补「类型」
      const neighborIds = [...new Set([...(upstream || []), ...(downstream || [])].map(d => d.decision_id || d.id).filter(Boolean))];
      const typeMap = {};
      if (neighborIds.length) {
        const nr = await query(
          `SELECT decision_id, scenario_id FROM crm.decision WHERE decision_id = ANY($1::uuid[])`,
          [neighborIds]
        ).catch(() => ({ rows: [] }));
        for (const r of (nr.rows || [])) typeMap[r.decision_id] = r.scenario_id;
      }

      // table「决策邻居」：upstream（先例/上游）优先，downstream 补充
      const neighborRows = [
        ...(upstream || []).map(d => ({
          decision_id: d.decision_id || d.id || '',
          type: typeMap[d.decision_id] || d.scenario_id || d.scenario || '',
          stage: d.disposition || d.state || '',
        })),
        ...(downstream || []).map(d => ({
          decision_id: d.decision_id || d.id || '',
          type: typeMap[d.decision_id] || d.scenario_id || d.scenario || '',
          stage: d.disposition || d.state || '',
        })),
      ];

      // subtable「溯源链」：audit.entries（决策/事件溯源条目；reason 取 payload.rationale，checksum 一并暴露供审计面校验）
      // 顶层结构：每条 entry 以 mainColumn/subColumns 顶层键映射（decision/entry_type、reason、precedent），
      //   checksum 同层暴露供审计面 SHA-256 校验（S14 schema subtable mainColumn='decision'、subColumns=['reason','precedent']）
      const entries = (audit.entries || []).map(e => ({
        decision: e.entry_type || e.type || 'decision',
        reason: e.payload?.rationale || e.rationale || e.reason || '',
        precedent: e.payload?.precedent_id || e.precedent_id || '',
        checksum: e.checksum || '',
      }));

      const traceFacts = {
        page: 'S14',
        hasDecision: !!decisionId,
        hasEdges: (audit.entries || []).some((e) => e.children?.length || e.parents?.length),
        hasTrace: (audit.entries || []).some((e) => e.trace?.length),
      };
      const data = {
        components: {
          // 同 kind 多组件 → 按 comp.title 索引映射（renderer resolveDatum：title 命中即取，防覆盖）
          // title 注入数据面：非空态也渲染组件标题（渲染器仅 data.title 显式注入时渲染，其余页面契约不变）
          table: {
            决策清单: { title: '决策清单', rows: decisionRows },
            决策邻居: { title: '决策邻居', rows: neighborRows },
          },
          subtable: {
            rows: entries.length ? [{
              decision: decisionId,
              trace: entries.map((en) => ({
                decision: en.decision,          // mainColumn 顶层映射：entry_type（decision/event…）
                reason: en.reason,              // subColumns.render：payload.rationale
                precedent: en.precedent,        // subColumns.render：precedent_id
                checksum: en.checksum,          // 审计面 SHA-256 校验和（顶层同列暴露）
              })),
            }] : [],
          },
          'reasoning-trace': {
            steps: buildReasoningSteps(S14_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [], traceFacts),
          },
        },
      };
      const rendered = renderPage(S14_SCHEMA, data);
      res.json({ schema: S14_SCHEMA, data, html: rendered.html, warnings: rendered.warnings, decisionId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S15 业务看板（L2C）受控渲染（复刻 S02/S06：renderPage 唯一出口 + schema 六卡 title 索引注入真实计数）───
  // 契约：GET /api/page/business-board → { schema:S15, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 数据面：六卡按 title 索引——线索=CRM_DEAL stage=lead / 商机=CRM_DEAL 非lead / 报价=CRM_QUOTATION /
  //         合同=CRM_CONTRACT / 订单=CRM_ORDER / 回款=CRM_PAYMENT_RECORD；table=L2C 阶段分布(stage/name/amount)
  app.get('/api/page/business-board', async (req, res) => {
    let me = {};
    try { me = resolveMe(req) || {}; } catch {}
    try {
      const focus = req.query.focus; // 'quoted' | 'contracted' | undefined
      const types = ['CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_ORDER', 'CRM_PAYMENT_RECORD', 'CRM_ACCOUNT'];
      const items = [];
      for (const t of types) {
        const rows = await queryParticles({ type: t, tenantId: scopeTenant(me), limit: 100 }).catch(() => []);
        items.push(...rows);
      }
      const grouped = {};
      for (const p of items) (grouped[p.type] ||= []).push(p);
      const deals = grouped.CRM_DEAL || [];
      const leadCount = deals.filter(d => normalizeDealStage(d) === 'S0').length; // T9：公海=stage S0（原 'lead'）
      const oppCount = deals.length - leadCount;
      const data = {
        components: {
          'metric-card': {
            线索: { value: leadCount },
            商机: { value: oppCount },
            报价: { value: (grouped.CRM_QUOTATION || []).length, ...(focus === 'quoted' ? { highlight: true } : {}) },
            合同: { value: (grouped.CRM_CONTRACT || []).length, ...(focus === 'contracted' ? { highlight: true } : {}) },
            订单: { value: (grouped.CRM_ORDER || []).length },
            回款: { value: (grouped.CRM_PAYMENT_RECORD || []).length },
          },
          table: {
            rows: (focus
              ? deals.filter(d => (d.payload?.stage || d.state) === focus)
              : deals
            ).map(d => ({ stage: normalizeDealStage(d) || 'S0', name: d.payload?.name || d.title || '商机', amount: d.payload?.expected_amount ?? d.payload?.amount ?? '' })),
          },
        },
      };
      const rendered = renderPage(S15_SCHEMA, data);
      res.json({ schema: S15_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S36 漏斗质量看板受控渲染（设计 2026-08-30 funnel-design §5.3：受控渲染，不写自由 HTML）───
  // 契约：GET /api/page/funnel-quality → { schema:S36, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 数据面（与 funnelRouter 同口径，避免两套逻辑漂移）：
  //   kpi-strip「漏斗健康性」= 销售潜力/年度目标/已签单/加权额/抖动率
  //   table「MANT 缺失清单」= 真实性——M/A/N/T 缺失商机（authenticity）
  //   table「商机明细」= 按漏斗区域/预测分类列商机
  // 阈值铁律：加权值/抖动/年度目标/承诺带一律经 config_store['sales-thresholds'].funnel，禁止硬编码。
  app.get('/api/page/funnel-quality', async (req, res) => {
    let me = {};
    try { me = resolveMe(req) || {}; } catch {}
    try {
      const owner = req.query.owner || null;
      const thresholds = mergedThresholds(await readTenantConfig('sales-thresholds', me));
      const deals = await queryParticles({ type: 'CRM_DEAL', tenantId: scopeTenant(me), limit: 500 });
      const scoped = owner ? deals.filter((d) => d.payload?.owner_id === owner) : deals;

      const zones = {};
      const classes = {};
      const authenticity = [];
      const commit = [];
      const dealRows = [];
      let weightedTotal = 0;
      let baseline = 0;
      let moved = 0;
      let closedAmount = 0;

      for (const d of scoped) {
        const f = d.payload?.funnel || {};
        const stage = d.payload?.stage;
        const mo = mantOk(f);
        const zone = funnelZone(d);
        const cls = forecastClass(d);
        const w = weightedAmount(d, thresholds);
        zones[zone] = (zones[zone] || 0) + 1;
        if (cls) classes[cls] = (classes[cls] || 0) + 1;
        weightedTotal += w;
        baseline += Number(f.baseline_amount || 0);
        if (['lost', 'LOST', 'deferred', 'DEFERRED'].includes(stage)) moved += Number(d.payload?.expected_amount || 0);
        if (['paid', 'ordered', 'PAID', 'ORDERED'].includes(stage)) closedAmount += Number(d.payload?.expected_amount || 0);
        if (f.committed) {
          const promised = Number(f.committed.amount || 0);
          const actual = Number(f.committed.actual || 0);
          if (promised > 0) {
            const acc = commitAccuracy(promised, actual, thresholds);
            commit.push({ title: d.payload?.name || d.title || d.id, rate: acc.rate, level: acc.level });
          }
        }
        if (!mo.ok) {
          authenticity.push({
            title: d.payload?.name || d.title || d.id,
            missing: (mo.missing || []).join('/'),
            zone,
            forecastClass: cls || '',
          });
        }
        dealRows.push({
          title: d.payload?.name || d.title || d.id,
          stage: stage || '',
          zone,
          forecastClass: cls || '',
          weighted: w,
          mantOk: mo.ok ? '齐' : '缺',
          expectedAmount: Number(d.payload?.expected_amount || 0),
        });
      }
      const zoneRows = Object.entries(zones).map(([zone, count]) => ({ zone, count }));
      const classRows = Object.entries(classes).map(([forecastClass, count]) => ({ forecastClass, count }));

      const annualTarget = Number(req.query.annualTarget) || Number(thresholds.funnel?.annual_target || 0) || 0;
      const health = salesPotential(scoped, annualTarget, closedAmount, thresholds);
      const breach = forecastBreach(health, thresholds);
      const jitter = jitterRate(baseline, moved);

      const data = {
        components: {
          'kpi-strip': {
            漏斗健康性: {
              items: [
                { label: '销售潜力', value: health, tone: breach ? 'warn' : 'ok' },
                { label: '年度目标', value: annualTarget },
                { label: '已签单', value: closedAmount },
                { label: '加权额', value: Math.round(weightedTotal) },
                { label: '抖动率', value: jitter == null ? '—' : `${(jitter * 100).toFixed(1)}%` },
              ],
            },
          },
          table: {
            漏斗区域分布: { rows: zoneRows },
            预测分类分布: { rows: classRows },
            'MANT 缺失清单': { rows: authenticity },
            承诺兑现: { rows: commit },
            商机明细: { rows: dealRows },
          },
        },
      };
      const rendered = renderPage(S36_SCHEMA, data);
      res.json({ schema: S36_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S02 AI 作战室首页受控渲染（Task 11 收尾：前台经 renderPage 唯一出口出片）───
  // 契约：GET /api/page/home → { schema:S02, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 数据面（2026-08-28 接真实数据）：DEAL 金额用 expected_amount（业务事实字段，amount 不存在）；
  //   三卡按真实今日优先口径（FIT=probability>=60% 商机 / TIMING=quoted 阶段 / CONN=contracted 阶段）；
  //   L2C 管线=全体 DEAL 按 stage；审批收件箱=报价/合同/发票/订单 approval_status∈{submitted,pending,in_review}；
  //   SSE 事件子表=真实 events 流水最近 8 条（非占位）——resolveDatum 按 comp.title 索引同 kind 多组件（renderer.js:67-75）
  app.get('/api/page/home', async (req, res) => {
    let me = {};
    try { me = resolveMe(req) || {}; } catch {}
    try {
      const types = ['CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD', 'CRM_INVOICE', 'CRM_ORDER'];
      const items = [];
      for (const t of types) {
        const rows = await queryParticles({ type: t, tenantId: scopeTenant(me), limit: 100 }).catch(() => []);
        items.push(...rows);
      }
      const grouped = {};
      for (const p of items) (grouped[p.type] ||= []).push(p);
      const board = { grouped, total: items.length };
      const deals = grouped.CRM_DEAL || [];
      const stageOf = (p) => normalizeDealStage(p) || 'S0';
      const dealRows = deals.map(p => ({
        name: p.payload?.name || p.title || p.id || '商机',
        stage: stageOf(p),
        amount: p.payload?.expected_amount ?? p.payload?.amount ?? '',
      }));
      // 三卡今日优先（真实口径，与 src/portal/scoring.js 对齐）
      const FIT = deals.filter(d => (d.payload?.probability ?? 0) >= 0.6).length;
      const TIMING = deals.filter(d => stageOf(d) === 'quoted').length;
      const CONN = deals.filter(d => stageOf(d) === 'contracted').length;
      // 审批收件箱：真实待审单据（approval_status 待审态；当前库已全批则自然为空）
      const approvalTypes = ['CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_INVOICE', 'CRM_ORDER'];
      const PENDING = ['submitted', 'pending', 'in_review'];
      const approvalRows = approvalTypes.flatMap(t =>
        (grouped[t] || [])
          .filter(x => PENDING.includes(x.payload?.approval_status))
          .map(x => ({ name: x.payload?.name || x.title || x.id || t, stage: x.payload?.approval_status || 'submitted', amount: x.payload?.amount ?? '' })));
      // SSE 真实事件子表：最近 8 条 events 流水
      let eventRows = [];
      try {
        const ev = await query(`SELECT type, payload, created_at FROM crm.events ORDER BY created_at DESC LIMIT 8`);
        eventRows = ev.rows.map(r => ({
          event: r.type || 'event',
          events: [{
            type: (r.payload?.actor || r.payload?.type || '').slice(0, 20) || 'system',
            entity: new Date(r.created_at).toISOString().slice(0, 16),
          }],
        }));
      } catch { eventRows = []; }

      // ── 工作台业务作战面板（2026-08-30）：聚合管道 / 客户跟踪 / 销售行为三数据源 ──
      // 与 /api/board/named-accounts 同源（buildNamedAccountBoard + boardSummary），owner 默认当前登录销售。
      let role = 'guest';
      try { if (me.role) role = me.role; } catch {}
      const isSales = role === 'sales';
      const ownerFilter = me.username || null;
      const [accParticles, conParticles, ctcParticles] = await Promise.all([
        queryParticles({ type: 'CRM_ACCOUNT', tenantId: scopeTenant(me), limit: 100 }).catch(() => []),
        queryParticles({ type: 'CRM_CONTRACT', tenantId: scopeTenant(me), limit: 100 }).catch(() => []),
        queryParticles({ type: 'CRM_CONTACT', tenantId: scopeTenant(me), limit: 200 }).catch(() => []),
      ]);
      const targetsCfg = mergedTargets(await readTenantConfig('named-account-targets', me));
      const behaviorStd = mergedBehaviorStd(await readTenantConfig('behavior-standard', me));
      const thresholds = mergedThresholds(await readTenantConfig('sales-thresholds', me));
      const naRows = buildNamedAccountBoard({ accounts: accParticles, deals, contracts: conParticles, contacts: ctcParticles, targetsCfg, ownerFilter, thresholds });
      const naSummary = boardSummary(accParticles, deals, conParticles, targetsCfg, ownerFilter, ctcParticles, behaviorStd, thresholds);
      const pm = pipelineMetrics(deals);
      const mkPct = (actual, target) => {
        const a = Number(actual || 0), t = Number(target || 0);
        const pct = t > 0 ? Math.round((a / t) * 100) : 100;
        return { percent: pct, state: (t === 0 || a >= t) ? 'ok' : 'warn', hint: `实际 ${a} / 目标 ${t}` };
      };
      const s = naSummary || {};
      const kpiPipeA = [
        { label: '在管商机', value: pm.inPipelineCount },
        { label: '管道总额', value: Math.round(pm.totalAmount), ...(isSales ? { state: 'hidden' } : {}) },
        { label: '加权预测', value: Math.round(pm.weightedForecast), ...(isSales ? { state: 'hidden' } : {}) },
        { label: '加权胜率', value: pm.weightedWinRate, unit: '%' },
      ];
      const kpiPipeB = [
        { label: '停滞商机', value: pm.staleCount },
        { label: '停滞金额占比', value: pm.staleAmountPct, unit: '%', ...(isSales ? { state: 'hidden' } : {}) },
        { label: '胜率', value: pm.winRate, unit: '%' },
        { label: '平均客单', value: Math.round(pm.avgDealAmount), ...(isSales ? { state: 'hidden' } : {}) },
      ];
      const custKpi = [
        { label: '目标客户数', value: s.targetCustomers ?? naRows.length },
        { label: '今日拜访', value: s.todayVisits ?? 0, hint: `目标 ${s.dailyVisitTarget ?? 2}`, state: ((s.todayVisits ?? 0) >= (s.dailyVisitTarget ?? 2)) ? 'ok' : 'warn' },
        { label: '今日电话', value: s.todayCalls ?? 0, hint: `目标 ${s.dailyCallTarget ?? 10}`, state: ((s.todayCalls ?? 0) >= (s.dailyCallTarget ?? 10)) ? 'ok' : 'warn' },
        { label: '本周拜访客户', value: s.weekVisitCustomers ?? 0, hint: `目标 ${s.weeklyVisitCustomerTarget ?? 8}`, state: ((s.weekVisitCustomers ?? 0) >= (s.weeklyVisitCustomerTarget ?? 8)) ? 'ok' : 'warn' },
        { label: '本周新客户', value: s.weekNewCustomers ?? 0, hint: `目标 ${s.weeklyNewCustomerTarget ?? 5}`, state: ((s.weekNewCustomers ?? 0) >= (s.weeklyNewCustomerTarget ?? 5)) ? 'ok' : 'warn' },
        { label: '本周拜访数', value: s.weekVisits ?? 0 },
        { label: '本月拜访数', value: s.monthVisits ?? 0 },
        { label: '21条合格率', value: s.behaviorPassRate ?? 0, unit: '%', state: ((s.behaviorPassRate ?? 0) >= (s.behaviorPassRateThreshold ?? 80)) ? 'ok' : 'warn' },
      ];
      const behaviorObj = {};
      [['今日拜访', s.todayVisits, s.dailyVisitTarget], ['今日电话', s.todayCalls, s.dailyCallTarget], ['本周拜访客户', s.weekVisitCustomers, s.weeklyVisitCustomerTarget], ['本周新客户', s.weekNewCustomers, s.weeklyNewCustomerTarget]].forEach(([t, a, tt]) => {
        const p = mkPct(a, tt); behaviorObj[t] = { percent: p.percent, label: t, state: p.state, hint: p.hint };
      });
      // ── 标准达标区（2026-08-30 三分类 B 类）：boardSummary.cov* 六键 → 4 张标准卡 ──
      // 语义：标准卡展示 出厂标准值（非 id31 个人目标），state 由达标布尔驱动（cov*Ok）；
      //    hint 显式「标准 N（实际 M）」——标准对比一目了然，杜绝「只见数字不知标准」。
      [['标准 · 客户数下限', s.covCustomerCountMin, s.covCustomerOk, '客户在管数 ≥'],
       ['标准 · 日均拜访', s.covDailyVisitTarget, s.covVisitsOk, '拜访+电话 ≥'],
       ['标准 · 周拜访数', s.covWeeklyVisitTarget, s.covWeekVisitsOk, '周拜访 ≥'],
       ['标准 · 信息收集/周', s.covInfoCollectWeekly, null, '周新增信息 ≥']].forEach(([t, std, ok, prefix]) => {
        behaviorObj[t] = { percent: 100, label: t, state: (ok === null || ok) ? 'ok' : 'warn', hint: `${prefix} ${std}` };
      });
      const topRows = (Array.isArray(naRows) ? naRows : []).slice(0, 8).map(r => ({
        id: r.id,
        name: r.name,
        tier: r.tier,
        visits: `${r.visits30 ?? 0}${r.visitPass ? ' ✅' : ' ⚠️'}`,
        behavior: `${r.behavior?.pass ?? 0}/${r.behavior?.total ?? 21}`,
        leads: r.leads ?? 0,
        opps: r.opps ?? 0,
        contracts: r.contracts ?? 0,
        gaps: Array.isArray(r.gaps) ? r.gaps.join('；') : '',
      }));
      // 销售角色对 L2C 管线原始金额列也做 🔒 掩码（与新 管道总览 区口径一致）
      const dealRowsMasked = isSales ? dealRows.map(r => ({ ...r, amount: '🔒' })) : dealRows;

      // S02 reasoning-trace 真状态（方案 B）：任务队列驱动
      const tasks = await listTasks({ tenantId: scopeTenant(me) }).catch(() => []);
      const traceFacts = {
        page: 'S02',
        hasTasks: tasks.length > 0,
        tasksHasContext: tasks.some((t) => t.payload?.context || t.payload?.input),
        hasActionableTask: tasks.some((t) => ['ready', 'running'].includes(t.status)),
      };
      const data = {
        components: {
          'goal-form': {},
          'metric-card': {
            '今日优先 · FIT': { value: FIT },
            '今日优先 · TIMING': { value: TIMING },
            '今日优先 · CONN': { value: CONN },
          },
          table: {
            'L2C 管线': { rows: dealRowsMasked },
            '审批收件箱': { rows: approvalRows },
            '指名客户 Top N': { rows: topRows },
          },
          'kpi-strip': {
            '管道 KPI-A': { items: kpiPipeA },
            '管道 KPI-B': { items: kpiPipeB },
            '客户 KPI': { items: custKpi },
          },
          pipeline: {
            '管道六段': { stages: pm.stages, conversions: pm.conversions, permHiddenStages: isSales ? pm.stages.map(x => x.key) : [] },
          },
          'progress-card': behaviorObj,
          'reasoning-trace': { steps: buildReasoningSteps(S02_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [], traceFacts) },
          subtable: { rows: eventRows },
        },
      };
      const rendered = renderPage(S02_SCHEMA, data);
      res.json({ schema: S02_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S34 今日优先·高匹配商机明细（FIT 钻取目标）───
  // 契约：GET /api/page/today-priority?dim=FIT → { schema:S34, data, html }；html=renderPage 产物
  app.get('/api/page/today-priority', async (req, res) => {
    let me = {};
    try { me = resolveMe(req) || {}; } catch {}
    try {
      const dim = req.query.dim;
      const rows = await queryParticles({ type: 'CRM_DEAL', tenantId: scopeTenant(me), limit: 100 }).catch(() => []);
      const fitRows = (dim === 'FIT' ? rows.filter(d => (d.payload?.probability ?? 0) >= 0.6) : rows)
        .map(d => ({
          id: d.id,
          name: d.payload?.name || d.title || '商机',
          stage: normalizeDealStage(d) || 'S0',
          probability: d.payload?.probability ?? '',
          amount: d.payload?.expected_amount ?? d.payload?.amount ?? '',
          owner: d.payload?.owner ?? '',
        }));
      const data = { components: { table: { '赢率≥60% 的高匹配商机': { rows: fitRows } } } };
      const rendered = renderPage(S34_SCHEMA, data);
      res.json({ schema: S34_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S03 智能体工作台受控渲染（复刻 S02：专用路由 + renderPage 注入真实数据）───
  // 契约：GET /api/page/agent-workbench → { schema:S03, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 真实数据面：kanban tasks（历史任务表）+ agent 装配状态（与 /api/agents 同源，不重复查）
  app.get('/api/page/agent-workbench', async (req, res) => {
    const me = resolveMe(req);
    try {
      const tasks = await listTasks({ tenantId: scopeTenant(me) });
      const asm = await assertAgentAssembly();
      const agentKeys = Object.keys(agentSpecs);
      let matrixRows = [];
      try { matrixRows = await computeCompliance(DEFAULT_CONTRACT_DOC); } catch {}
      const rows = tasks.map(t => ({
        task_id: t.id,
        type: t.action_name || t.step || '',
        status: t.status || '',
        created_at: t.created_at ? String(t.created_at).slice(0, 19) : '',
      }));
      const ACTIVE = ['ready', 'running', 'awaiting_confirm', 'blocked'];
      const taskList = tasks
        .map((t) => ({
          task_id: t.id,
          title: t.title || '',
          action: t.action_name || t.step || '',
          status: t.status || '',
          owner: t.worker_host || '—',
          updated_at: t.updated_at ? String(t.updated_at).slice(0, 19) : '',
        }))
        .sort((a, b) => (ACTIVE.includes(b.status) ? 1 : 0) - (ACTIVE.includes(a.status) ? 1 : 0));
      const data = {
        components: {
          'goal-form': {},
          'task-monitor': { rows: taskList },
          'reasoning-trace': { steps: S03_SCHEMA.components.find((c) => c.kind === 'tabs')?.tabs?.find((t) => t.key === 'detail')?.components?.find((x) => x.kind === 'reasoning-trace')?.steps || [] },
          'result-card': {
            items: [
              { label: '智能体', value: `${agentKeys.length} 个` },
              { label: '装配状态', value: asm && asm.ok ? '健康' : '异常' },
              { label: '历史任务', value: `${tasks.length} 条` },
            ],
          },
          table: { rows },
          'attr-field': {},
          'contract-matrix': { rows: matrixRows },
        },
      };
      const rendered = renderPage(S03_SCHEMA, data);
      res.json({ schema: S03_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── 智能体契约监控回写端点（Task3：/api/agent-monitor 三端点）───
  const DEFAULT_CONTRACT_DOC = fileURLToPath(new URL('../../docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md', import.meta.url));

  app.get('/api/agent-monitor', async (req, res) => {
    try {
      const doc = req.query.doc || DEFAULT_CONTRACT_DOC;
      const matrix = await computeCompliance(doc);
      res.json({ ok: true, doc, matrix });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent-monitor/feedback', async (req, res) => {
    try {
      const { contractTaskId, agent, gapType, observed, expected, severity, doc } = req.body || {};
      const row = await upsertFeedback({ contractTaskId, agent, gapType, observed, expected, severity });
      const mirror = mirrorFeedback(doc, { contractTaskId, agent, gapType, observed, expected, severity });
      res.json({ ok: true, row, mirror });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent-monitor/success', async (req, res) => {
    try {
      const { contractTaskId, marked } = req.body || {};
      const row = await markSuccess(contractTaskId, marked);
      res.json({ ok: true, row });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 单任务 trace 回放（B-γ 详情 TAB）：从 monitor_event 按 payload.taskId 回放历史阶段 + 当前任务状态
  // 修复（2026-08-29）：① SELECT 补 context_facts（原只查 payload → 详情无法展开）；
  // ② 返回 steps 级结构化详情（intent/context/action 三段各自从 context_facts 提取），供前端 reasoning-trace 展开查看
  app.get('/api/agent-monitor/trace/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const evs = await query(
        `SELECT event_type, context_facts, payload, created_at FROM crm.monitor_event WHERE payload->>'taskId'=$1 ORDER BY created_at`,
        [taskId]
      );
      const t = await query('SELECT status FROM crm.tasks WHERE id=$1', [taskId]);
      const phases = evs.rows.map((r) => ({
        phase: r.event_type,
        taskId: r.payload?.taskId,
        ts: String(r.created_at).slice(0, 19),
      }));
      // 按 step 归类详情（真实 event_type 名，无 agent- 前缀；与 recordEpisode 写入一致）
      const asFacts = (cf) => (typeof cf === 'string'
        ? (() => { try { return JSON.parse(cf); } catch { return {}; } })()
        : (cf || {}));
      const nz = (v) => (v === undefined || v === null || v === '' ? null : v);
      const ep = {};
      for (const r of evs.rows) ep[r.event_type] = { cf: asFacts(r.context_facts), payload: r.payload || {}, ts: String(r.created_at).slice(0, 19) };
      const a = ep['intent-parsed'];
      const c = ep['context-injected'];
      const act = ep['loop-failed'] || ep['loop-done'] || ep['loop-started'];
      const steps = {
        intent: a ? {
          intent: nz(a.cf.intent), action: nz(a.payload.action),
          contract_task_id: nz(a.cf.contract_task_id), ts: a.ts,
        } : null,
        context: c ? {
          knowledge_layers_read: Array.isArray(c.cf.knowledge_layers_read) ? c.cf.knowledge_layers_read : null,
          context_len: nz(c.cf.context_len), contract_task_id: nz(c.cf.contract_task_id),
          preview: nz(c.cf.preview), ts: c.ts,
        } : null,
        action: act ? {
          skill: nz(act.cf.skill),
          status: ep['loop-failed'] ? 'failed' : (ep['loop-done'] ? 'done' : 'started'),
          degraded: nz(act.cf.degraded), ms: nz(act.cf.ms),
          error: nz(ep['loop-failed']?.cf.error), contract_task_id: nz(act.cf.contract_task_id), ts: act.ts,
        } : null,
      };
      res.json({ ok: true, taskId, status: t.rows[0]?.status || 'unknown', phases, steps });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── S06 客户 360 受控渲染（复刻 S02/S03：专用路由 + renderPage 注入真实数据）───
  // 契约：GET /api/page/account-360?accountId= → { schema:S06, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 真实数据面：CRM_ACCOUNT + 关联 CRM_CONTACT + CRM_DEAL（按 tenantId，account_id 关联）；七维画像由 payload 派生（非硬编码）
  app.get('/api/page/account-360', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me.ok) return res.status(401).json({ error: me.error });
      const accountId = req.query.accountId || null;
      const accounts = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: scopeTenant(me), limit: 100 });
      // 默认选客优先级（T2）：我的客户(owner=actor) > 完整 payload > 首条；避免盲取空 fixture
      const actor = (me.username && typeof resolveActor === 'function') ? await resolveActor(me.username) : null;
      const account = (accountId && accounts.find(a => a.id === accountId || a.slug === accountId))
        || (actor ? accounts.find(a => a.payload?.owner_id === actor) : null)
        || accounts.find(a => a.payload?.industry || a.payload?.region || a.payload?.owner)
        || accounts[0] || null;
      if (!account) {
        const rendered = renderPage(S06_SCHEMA, { state: 'empty' });
        return res.json({ schema: S06_SCHEMA, data: { state: 'empty' }, html: rendered.html, warnings: rendered.warnings });
      }
      const contacts = await queryParticles({ type: 'CRM_CONTACT', tenantId: scopeTenant(me), limit: 100 });
      const deals = await queryParticles({ type: 'CRM_DEAL', tenantId: scopeTenant(me), limit: 100 })
        .then(rows => rows.filter(d => (d.payload?.account_id || '') === account.id));
      const p = account.payload || {};
      const contactCount = contacts.length;
      const dealCount = deals.length;
      // 七维完整性：由 payload 实际字段派生（完整/部分/缺失），非写死
      const dim = (ok, partial) => ok ? '完整' : (partial ? '部分' : '缺失');
      const dims = {
        '身份': dim(!!(p.name || account.title) && !!account.id),
        '结构': dim(contactCount > 0 || dealCount > 0),
        '语义': dim(!!(p.industry || p.region)),
        '时间与配置': dim(!!(p.last_interaction || p.created_at || p.updated_at)),
        '决策历史': p.decision_refs ? '完整' : dim(false, !!p.last_interaction),
        '运营状态': dim(!!(p.status || p.rating)),
        '治理': dim(!!(p.owner || p.rbac)),
      };
      const dealIds = deals.map(d => d.id);
      const evRows = await query(
        `SELECT payload->>'title' AS title, payload->>'type' AS type, created_at
         FROM crm.events WHERE payload->>'account_id'=$1 OR payload->>'deal_id'=ANY($2::text[])
         ORDER BY created_at DESC LIMIT 3`,
        [account.id, dealIds]
      ).then(r => r.rows.map(e => ({
        ts: e.created_at?.toISOString?.() || String(e.created_at),
        type: e.type || 'event',
        title: e.title || '事件',
      })));
      const aiSuggestion = (dealCount === 0 && contactCount === 0)
        ? '该客户暂无任何商机与联系人，建议优先补全画像并指派 owner。'
        : `当前 ${dealCount} 个商机、${contactCount} 个联系人；最近事件：${evRows[0]?.title || '无'}。`;
      // 空画像引导（T4）：行业/区域/owner 全缺 → 提示补全
      const profileHint = (!p.industry && !p.region && !p.owner)
        ? '该客户画像缺失（行业/区域/负责人均未填）。建议指派负责人并补全工商信息，七维完整度将自动提升。'
        : null;
      // 去重低置信提示（2026-09-08，docs/plans/2026-09-07-crm-dedup.md 任务5a）：
      // 创建闸标 possible_duplicate_of 的账户 → 高亮提示人工核对（不静默归并）
      const dupHint = p.possible_duplicate_of
        ? `⚠️ 疑似重复客户（低置信）：本客户与 <a href="/account-360.html?id=${encodeURIComponent(p.possible_duplicate_of)}">${p.possible_duplicate_of}</a> 名称相似，请人工核对后决定是否归并。`
        : null;
      const finalProfileHint = dupHint || profileHint;
      // S13：目标达标数据面（config_store['named-account-targets'] + payload.tier + visit_notes 窗口过滤）
      // 注意：config_store 可能为空 → mergedTargets 铺底（DEFAULTS 三档），否则 tierOf 在 [] 上 find 崩
      const targetsCfg = mergedTargets(await readTenantConfig('named-account-targets', me));
      const targetVisit = visitTargetFor(p, targetsCfg);
      // 2026-09-03 死区修复（与 S35 同源）：原探测 crm.tasks（kanban 调度队列，0 行、payload 无 account_id）
      // 恒空 → tasksNonEmpty 恒 false → S06『洞察建议』reasoning 步骤永为 idle。改用真实活动信号
      // evRows（crm.events 已 fetch，account 或 deal 关联），有事件即视为有跟进活动。
      const traceFacts = {
        page: 'S06',
        profileFilled: !!(p.industry || p.region || p.owner || p.tier),
        sevenDimCovered: Object.values(dims).every((d) => d === '完整'),
        tasksNonEmpty: (evRows?.length || 0) > 0,
      };
      const data = {
        components: {
          'attr-field': {
            name: { value: p.name || account.title || '' },
            industry: { value: p.industry || '' },
            status: { value: p.status || (p.rating ? `评级 ${p.rating}` : 'ACTIVE') },
          },
          table: { '最新动态': { rows: evRows } },
          'result-card': { 'AI 下一步建议': { summary: aiSuggestion } },
          'metric-card': Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, { value: v }])),
          'reasoning-trace': { steps: buildReasoningSteps(S06_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [], traceFacts) },
          'target-card': {
            '目标达标': {
              tier: targetVisit.tier || '潜力',
              target: targetVisit.target ?? 1,
              window: targetVisit.window || 'month',
              actual: targetVisit.actual ?? 0,
              pass: !!targetVisit.pass,
              // ④ 指标口径映射（接通引擎）：随配置变化驱动维度展示
              metrics: metricDimensions(targetsCfg),
            },
          },
        },
      };
      const rendered = renderPage(S06_SCHEMA, data);
      res.json({ schema: S06_SCHEMA, data, html: rendered.html, warnings: rendered.warnings, accountId: account.id, profileHint: finalProfileHint });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S35 客户洞察受控渲染（双页分离第二页）───
  // 契约：GET /api/page/account-insight?accountId= → { schema, data, html, role, warnings }
  app.get('/api/page/account-insight', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me.ok) return res.status(401).json({ error: me.error });
      const role = me.role || 'sales';
      const profile = await loadProfile(role);
      const accountId = req.query.accountId || null;
      const accounts = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: scopeTenant(me), limit: 100 });
      const account = (accountId && accounts.find(a => a.id === accountId || a.slug === accountId)) || accounts[0] || null;
      if (!account) {
        const rendered = renderPage(S35_SCHEMA, { state: 'empty' });
        return res.json({ schema: S35_SCHEMA, data: { state: 'empty' }, html: rendered.html, warnings: rendered.warnings, role });
      }
      const actor = await resolveActor(me.username);
      // 越权（self 模型且 owner 不匹配）→ 403（设计 §4.2 数据范围闸）
      if (profile?.data_scope?.model === 'self' && actor && account.payload?.owner_id && account.payload.owner_id !== actor) {
        return res.status(403).json({ error: 'scope_violation', gate: 'scope', reason: `owner ${account.payload.owner_id} != ${actor}` });
      }
      const dealIds = (await queryParticles({ type: 'CRM_DEAL', tenantId: scopeTenant(me), limit: 200 }))
        .filter(d => (d.payload?.account_id || '') === account.id).map(d => d.id);
      const related = await loadRelatedParticles(account.id, dealIds, scopeTenant(me));
      // 数据范围：仅 domain 模型生效（finance/presales/contract_admin）；self/all/org_subtree 透传（账户级闸已约束）
      const flat = Object.values(related).flat();
      const scoped = profile?.data_scope?.model === 'domain' ? applyScopeFilter(flat, profile, actor) : flat;
      const scopedById = new Map(scoped.map(p => [p.id, p]));
      const pick = (t) => (related[t] || []).filter(p => scopedById.has(p.id));

      const timelineSources = await loadTimelineSources(account.id, dealIds, scopeTenant(me));
      const timeline = buildTimelineRows(timelineSources);
      const tx = buildTransactionRows({
        deals: pick('CRM_DEAL'), quotations: pick('CRM_QUOTATION'), contracts: pick('CRM_CONTRACT'),
        orders: pick('CRM_ORDER'), payments: pick('CRM_PAYMENT_RECORD'), invoices: pick('CRM_INVOICE'),
      });
      const decisions = await loadDecisions(account.id, dealIds);
      // 2026-09-03：原 crm.tasks 绑错源——该表 0 行、是 kanban 调度队列（payload 无 account_id）。
      // 折叠卡「客户任务线」恒空 = 不存在的领域概念承诺。改用 loadDecisionTrace（决策执行足迹）：
      // decision_event 表已有数据，承载 AI 建议/置信度/实际 disposition/业务分级，更贴客户跟进语义。
      const decisionTrace = await loadDecisionTrace(account.id, dealIds);

      // 数字化指标聚合（重设计 §5.1–5.4）：交易金额四联 / L2C 六段 / 过程活跃度 / 决策与风险
      // 2026-09-03：第 3 参 tasks 源由 crm.tasks 切到 decisionTrace（决策事件），taskTotal 现在
      //   等于「该客户决策事件数」，比 crm.tasks（kanban 队列 0 行）更具业务代表性；老接口保持兼容。
      const m = buildMetrics(
        {
          deals: pick('CRM_DEAL'), quotations: pick('CRM_QUOTATION'), contracts: pick('CRM_CONTRACT'),
          orders: pick('CRM_ORDER'), payments: pick('CRM_PAYMENT_RECORD'), invoices: pick('CRM_INVOICE'),
        },
        timelineSources, decisionTrace, decisions
      );
      const fmt = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-CN'));
      const rateState = (r) => (r === null || r === undefined ? 'neutral' : r >= 70 ? 'good' : r >= 40 ? 'warn' : 'bad');
      const daysState = (d) => (d === null || d === undefined ? 'neutral' : d > 30 ? 'bad' : d > 14 ? 'warn' : 'good');
      const contractCount = pick('CRM_CONTRACT').length;

      // 数据按组件 kind 分组、再按组件 title 索引（对齐 renderer resolveDatum 契约）
      const traceFacts = {
        page: 'S35',
        timelineNonEmpty: (timelineSources || []).length > 0,
        roleHasPerm: !!role,
        // 2026-09-03：traceFact 由「tasks 是否空」改为「decisionTrace 是否空」——这才是页面上真正
        //   决定「决策执行足迹」折叠卡是否值得展开 AI 洞察的依据。
        tasksNonEmpty: (decisionTrace || []).length > 0,
      };
      const data = {
        components: {
          'kpi-strip': {
            '交易金额四联': {
              items: [
                { key: 'contractAmt', label: '合同总额', value: m.money.contractAmt, unit: '¥', state: 'neutral',
                  hint: contractCount ? `${contractCount} 份合同` : '' },
                { key: 'paidAmt', label: '已回款', value: m.money.paidAmt, unit: '¥', state: 'good', hint: '' },
                { key: 'unpaidAmt', label: '未回款', value: m.money.unpaidAmt, unit: '¥', state: 'warn', hint: '' },
                { key: 'payRate', label: '回款率', value: m.money.payRate, unit: '%', state: rateState(m.money.payRate), hint: '' },
              ],
            },
            '过程活跃度': {
              items: [
                { key: 'interactions', label: '互动次数', value: m.activity.interactions, state: 'neutral',
                  hint: `近 30 天 ${m.activity.interactions30d} 次` },
                { key: 'interactions30d', label: '30 天互动', value: m.activity.interactions30d, state: 'neutral', hint: '' },
                { key: 'taskTotal', label: '决策事件', value: m.activity.taskTotal,
                  state: m.activity.taskOverdue === null ? 'neutral' : (m.activity.taskOverdue > 0 ? 'warn' : 'good'),
                  hint: m.activity.taskOverdue === null ? '无到期字段'
                    : (m.activity.taskOverdue > 0 ? `${m.activity.taskOverdue} 项已逾期` : '无逾期') },
                { key: 'lastFollowDays', label: '最近跟进', value: m.activity.lastFollowDays, unit: '天前',
                  state: daysState(m.activity.lastFollowDays), hint: '' },
              ],
            },
            '决策与风险': {
              items: [
                { key: 'decTotal', label: '决策总数', value: m.decision.decTotal, state: 'neutral', hint: '' },
                { key: 'decExc', label: '例外数', value: m.decision.decExc, state: m.decision.decExc > 0 ? 'warn' : 'good', hint: '' },
                { key: 'excRate', label: '例外率', value: m.decision.excRate, unit: '%',
                  state: m.decision.excRate === null ? 'neutral' : m.decision.excRate > 30 ? 'bad' : 'warn', hint: '' },
              ],
            },
          },
          // L2C 六段管道（明细表格已由本组件取代，避免同信息两处重复）
          pipeline: {
            'L2C 六段管道': { stages: m.pipeline.stages, conversions: m.pipeline.conversions },
          },
          'progress-card': {
            '回款进度': {
              percent: m.money.payRate, label: '回款进度', state: rateState(m.money.payRate),
              hint: (m.money.paidAmt !== null && m.money.contractAmt !== null)
                ? `已回款 ¥${fmt(m.money.paidAmt)} / 合同 ¥${fmt(m.money.contractAmt)}` : '',
            },
            '客户健康度': {
              percent: m.decision.healthScore, label: '客户健康度', state: m.decision.healthState,
              hint: m.decision.decExc > 0 ? `决策例外 ${m.decision.decExc} 起` : '',
            },
          },
          table: {
            '时间线': { rows: timeline },
            '执行足迹': { rows: decisionTrace },
            '决策链': { rows: decisions },
          },
          'reasoning-trace': {
            'AI 洞察': { steps: buildReasoningSteps(S35_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [], traceFacts) },
          },
          'attr-field': {
            biz: { value: account.payload?.business_title || '', verified: account.payload?.business_verified === true },
          },
          // result-card 不提供数据 → 仅渲染标题（章节分隔）
        },
      };
      // 字段级权限：克隆 schema 后按角色剔除隐藏列/字段，并把隐藏标记落到数据层
      const schemaForRole = applyFieldPerms(S35_SCHEMA, role);
      const dataForRole = maskMetricsByPerm(schemaForRole, data);
      const rendered = renderPage(schemaForRole, dataForRole);
      res.json({ schema: schemaForRole, data: dataForRole, html: rendered.html, warnings: rendered.warnings, role, accountId: account.id, accountTitle: account.title || account.payload?.name || '' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S05 待办工作台（四角色视角）真实数据渲染（TDD：复用 S02/S03/S06 范式）───
  // 真实数据源 = board 粒子（CRM_DEAL 跟进 + 四类 submitted 审批单 + 回款 pending）；按 role 视角过滤。
  // 不调用 getDecisionList（避免 decision-store 种子依赖）；审批项本身即"待决决策"，已覆盖 schema 意图。
  app.get('/api/page/todo', async (req, res) => {
    try {
      // 修复（2026-09-01）：scopeTenant(me) 引用未声明的 me → ReferenceError 恒 500（待办页全白）
      let me;
      try { me = resolveMe(req); } catch { me = { ok: false }; }
      const role = ['sales', 'manager', 'finance', 'contract'].includes(req.query.role) ? req.query.role : 'sales';
      const types = ['CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_INVOICE', 'CRM_ORDER', 'CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD'];
      const items = [];
      for (const t of types) {
        const rows = await queryParticles({ type: t, tenantId: scopeTenant(me), limit: 200 }).catch(() => []);
        items.push(...rows);
      }
      const grouped = {};
      for (const p of items) (grouped[p.type] ||= []).push(p);

      const APPROVAL_TYPES = { CRM_QUOTATION: '报价', CRM_CONTRACT: '合同', CRM_INVOICE: '发票', CRM_ORDER: '订单' };
      const todos = [];
      // ① 待审批（submitted 审批单 → 待决决策；全角色可见）
      for (const [type, label] of Object.entries(APPROVAL_TYPES)) {
        for (const p of (grouped[type] || [])) {
          if (p.payload?.status === 'submitted') {
            todos.push({
              deal: `${label}单 ${p.payload?.name || p.slug || p.id}`,
              customer: p.payload?.customer || p.payload?.account_name || '—',
              stage: '待审批', due: '待审批', action: '审批',
            });
          }
        }
      }
      // ② 商机跟进（在跟 = 非终态 S1–S6，排除 S7 输单 / S8 丢单）
      // 2026-09-09 修复：与 workbenchRouter follow 视角同构（原按旧英文值 lead/opportunity 过滤 → 漏报）。
      //   判定统一走 stageTaxonomy.isOpenStage（单一事实源），脏值/缺失 fail-open 计入。
      for (const d of (grouped.CRM_DEAL || [])) {
        const raw = d.payload?.stage;
        // 2026-09-11 T9（P0）：公海 S0 无人跟进，不得进任何人的待办。
        //   必须显式排除：isOpenStage('S0')===true（S0 非终态 → fail-open 计入），
        //   否则全部公海线索会灌入待办列表。
        if (isPoolStage(raw)) continue;
        if (!isOpenStage(raw)) continue;
        const st = toStageCode(raw) || raw || 'S1';
        todos.push({
          deal: d.payload?.name || d.slug || '商机',
          customer: d.payload?.customer || d.payload?.account_name || '—',
          stage: st, due: '跟进', action: '跟进',
        });
      }
      // ③ 回款/应收（payment 类 pending/submitted）
      for (const t of ['CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD']) {
        for (const p of (grouped[t] || [])) {
          if (p.payload?.status === 'submitted' || p.payload?.status === 'pending') {
            todos.push({
              deal: `${t === 'CRM_PAYMENT_PLAN' ? '回款计划' : '回款记录'} ${p.payload?.name || p.slug || p.id}`,
              customer: p.payload?.customer || '—',
              stage: p.payload?.status, due: '应收', action: '核对',
            });
          }
        }
      }
      // ③b 逾期催收（S05 T3：PAYMENT_PLAN 已过 plan_end 且未 done → 派生催收待办，finance 可见）
      for (const p of (grouped.CRM_PAYMENT_PLAN || [])) {
        const rc = reconcilePlan({
          id: p.id, contract_id: p.payload?.contract_id,
          plan_amount: p.payload?.plan_amount, plan_end: p.payload?.plan_end, plan_status: p.payload?.plan_status,
        }, [], { today: new Date() });
        if (rc.overdue) {
          todos.push({
            deal: `回款计划 ${p.payload?.name || p.slug || p.id}`,
            customer: p.payload?.customer || '—',
            stage: '逾期催收', due: `${rc.due_days}天`, action: '催收',
          });
        }
      }

      const ROLE_FILTER = {
        sales: (t) => t.action === '跟进' || t.action === '审批',
        manager: () => true,
        finance: (t) => t.action === '审批' || t.action === '核对' || t.action === '催收',
        contract: (t) => t.action === '审批' || t.deal.includes('合同') || t.deal.includes('报价'),
      };
      const rows = todos.filter(ROLE_FILTER[role] || ROLE_FILTER.sales);

      const data = {
        components: {
          select: {
            options: [
              { value: 'sales', label: '销售' },
              { value: 'manager', label: '经理' },
              { value: 'finance', label: '财务' },
              { value: 'contract', label: '合同' },
            ],
            value: role,
          },
          table: { rows },
        },
      };
      const rendered = renderPage(S05_SCHEMA, data);
      res.json({ schema: S05_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S07 商机详情/作战视图（受控渲染：renderPage(S07_SCHEMA) + 真实聚合数据）───
  // 与通用 /deals/:id（字段来源核查，9ba0ff5 基础设施）互补：本路由渲染 S07 业务专属组件
  // （赢率 metric-card / 报价合同回款 subtable / MEDDICC reasoning-trace / 阶段推进 goal-form）
  app.get('/api/page/deal-detail', async (req, res) => {
    try {
      // 修复（2026-09-01）：REL 关联单据查询引用了未声明的 me → ReferenceError「me is not defined」
      //   → 该端点恒 500（S07 商机详情页全白）。按既有 handler 惯例在此解析身份（未登录回退 system 租户）。
      let me;
      try { me = resolveMe(req); } catch { me = { ok: false }; }
      let dealId = req.query.dealId || req.query.id;
      if (!dealId) {
        // 默认回落：优先「有金额的实质商机」，其次按最近更新。
        // 原因：直接 ORDER BY created_at DESC 会落到冒烟/测试产生的空壳商机
        // （payload 仅含 name+stage，无 expected_amount/probability/关联单据），表现为「详情页一片空白」。
        const fr = await query(
          "SELECT id FROM crm.particles WHERE type='CRM_DEAL' " +
          "ORDER BY (payload ? 'expected_amount') DESC, updated_at DESC NULLS LAST LIMIT 1"
        );
        dealId = fr.rows[0]?.id;
      }
      if (!dealId) return res.status(404).json({ error: 'no deal found' });
      const deal = await getParticle(dealId);
      if (!deal) return res.status(404).json({ error: 'deal not found' });
      // 关联单据：报价/合同/订单/回款/发票 均通过 payload.deal_id 挂接
      const REL = ['CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_ORDER', 'CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD', 'CRM_INVOICE'];
      const related = [];
      for (const t of REL) {
        const rows = await queryParticles({ type: t, tenantId: scopeTenant(me), limit: 100 }).catch(() => []);
        for (const p of rows) {
          if (p.payload && p.payload.deal_id === dealId) related.push(p);
        }
      }
      const p = deal.payload || {};
      const meddiccKeys = ['metrics', 'economic', 'decision', 'decision_roles', 'identify', 'competition', 'timeline'];
      const dealTaskRows = await query(`SELECT status FROM crm.tasks WHERE payload->>'deal_id'=$1`, [dealId]).catch(() => ({ rows: [] }));
      const traceFacts = {
        page: 'S07',
        meddiccFilled: meddiccKeys.every((k) => p[k]),
        hasDecisionHistory: !!(p.decision_refs || p.decision_id),
        hasFollowupTask: (dealTaskRows?.rows || []).some((t) => ['ready', 'running'].includes(t.status)),
      };
      const data = {
        components: {
          'attr-field': {
            deal_name: { value: p.name || deal.slug || '' },
            amount: { value: p.expected_amount ?? p.amount ?? '' },
            stage: { value: p.stage || '' },
          },
          'subtable': {
            '报价/合同/回款': {
              rows: related.map(doc => {
                const dp = doc.payload || {};
                const state = dp.status || dp.approval_status || dp.state || doc.state;
                const docLabel = dp.name || dp.contract_no || dp.order_no || dp.payment_no || doc.type;
                return { doc: docLabel, type: doc.type, state, amount: dp.amount ?? '', docs: [{ type: doc.type, state, amount: dp.amount ?? '' }] };
              }),
            },
          },
          'metric-card': {
            '赢率': { value: Math.round((p.probability ?? 0) * 100) },
          },
          'reasoning-trace': { steps: buildReasoningSteps(S07_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [], traceFacts) },
        },
      };
      const rendered = renderPage(S07_SCHEMA, data);
      res.json({ schema: S07_SCHEMA, data, html: rendered.html, warnings: rendered.warnings, dealId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S08 报价详情 受控渲染（复刻 S07：renderPage(S08_SCHEMA) + 真实聚合数据）───
  // 与通用 /quotes/:id（字段来源核查，9ba0ff5 基础设施）互补：本路由渲染 S08 业务专属组件
  // （报价明细行 subtable / 历史版本 table / 报价单号·总金额·有效期 attr-field / 生成刷新 goal-form）
  app.get('/api/page/quotation-detail', async (req, res) => {
    try {
      let quoteId = req.query.quoteId || req.query.id;
      if (!quoteId) {
        const fr = await query("SELECT id FROM crm.particles WHERE type='CRM_QUOTATION' ORDER BY created_at DESC LIMIT 1");
        quoteId = fr.rows[0]?.id;
      }
      if (!quoteId) return res.status(404).json({ error: 'no quotation found' });
      const quote = await getParticle(quoteId);
      if (!quote) return res.status(404).json({ error: 'quotation not found' });
      const p = quote.payload || {};
      const items = Array.isArray(p.items) ? p.items : [];
      // 明细行：product/qty/price/amount（amount = qty×unit_price×(1-discount)）
      const lineRows = items.map((it, i) => {
        const qty = Number(it.qty || 0);
        const price = Number(it.unit_price || 0);
        const discount = Number(it.discount || 0);
        const amount = Math.round(qty * price * (1 - discount));
        return {
          line: `第${i + 1}行`,
          product: it.product_id || it.product || '',
          qty, price, amount,
          lines: [{ product: it.product_id || it.product || '', qty, price, amount }],
        };
      });
      const data = {
        components: {
          'attr-field': {
            quote_no: { value: p.name || quote.slug || '' },
            total_amount: { value: p.amount ?? '' },
            valid_until: { value: p.valid_until || '' },
          },
          'subtable': {
            '报价明细行': { rows: lineRows },
          },
          'table': {
            '历史版本': { rows: [{ version: p.version || 'v1', amount: p.amount ?? '', updated_at: String(quote.updated_at || '').slice(0, 19) }] },
          },
          'goal-form': {},
        },
      };
      const rendered = renderPage(S08_SCHEMA, data);
      res.json({ schema: S08_SCHEMA, data, html: rendered.html, warnings: rendered.warnings, quoteId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S09 合同详情 受控渲染（复刻 S07/S08：专用路由 + renderPage 注入真实数据）───
  // 契约：GET /api/page/contract-detail?contractId= → { schema:S09, data, html }；html 为 renderPage 产物
  // 真实数据面：合同粒子 + 回款计划/发票（subtable）+ 条款风险推理链（reasoning-trace 静态步骤）
  app.get('/api/page/contract-detail', async (req, res) => {
    try {
      // 修复（2026-09-01）：同 deal-detail——回款计划/发票查询引用未声明的 me → 端点恒 500
      let me;
      try { me = resolveMe(req); } catch { me = { ok: false }; }
      let contractId = req.query.contractId || req.query.id;
      if (!contractId) {
        const fr = await query("SELECT id FROM crm.particles WHERE type='CRM_CONTRACT' ORDER BY created_at DESC LIMIT 1");
        contractId = fr.rows[0]?.id;
      }
      if (!contractId) return res.status(404).json({ error: 'no contract found' });
      const contract = await getParticle(contractId);
      if (!contract) return res.status(404).json({ error: 'contract not found' });
      const p = contract.payload || {};
      // 回款计划 / 发票（按 payload.contract_id 关联）
      const [plans, invoices] = await Promise.all([
        queryParticles({ type: 'CRM_PAYMENT_PLAN', tenantId: scopeTenant(me), limit: 100 }).catch(() => []),
        queryParticles({ type: 'CRM_INVOICE', tenantId: scopeTenant(me), limit: 100 }).catch(() => []),
      ]);
      const planRows = plans.filter(x => x.payload?.contract_id === contractId).map(x => ({
        type: '回款计划', due: x.payload?.plan_end || '', amount: x.payload?.plan_amount ?? '', status: x.payload?.plan_status || '',
      }));
      const invoiceRows = invoices.filter(x => x.payload?.contract_id === contractId).map(x => ({
        type: '发票', due: x.payload?.invoice_date || '', amount: x.payload?.invoice_amount ?? '', status: x.payload?.reconcile_status || '',
      }));
      const hasClause = !!(p.clauses || p.payment_terms || p.terms);
      const hasOverduePlan = planRows.some((x) => {
        const due = new Date(x.due).getTime();
        return x.status !== 'paid' && x.status !== 'completed' && due && due < Date.now();
      });
      const traceFacts = { page: 'S09', hasClause, hasOverduePlan };
      const data = {
        components: {
          'attr-field': {
            contract_no: { value: p.contract_no || contract.slug || '' },
            contract_amount: { value: p.amount ?? '' },
            sign_date: { value: p.start_date || '' },
          },
          'subtable': {
            '回款计划/发票': { rows: [{ doc: '回款计划 / 发票', docs: [...planRows, ...invoiceRows] }] },
          },
          'reasoning-trace': { steps: buildReasoningSteps(S09_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [], traceFacts) },
          'goal-form': {},
        },
      };
      const rendered = renderPage(S09_SCHEMA, data);
      res.json({ schema: S09_SCHEMA, data, html: rendered.html, warnings: rendered.warnings, contractId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 契约：GET /api/page/order-detail?orderId= → { schema:S10, data, html }；html 为 renderPage 产物
  // 真实数据面：订单粒子 + 履约节点（subtable，按订单状态推导里程碑 plan/actual/status）
  app.get('/api/page/order-detail', async (req, res) => {
    try {
      let orderId = req.query.orderId || req.query.id;
      if (!orderId) {
        const fr = await query("SELECT id FROM crm.particles WHERE type='CRM_ORDER' ORDER BY created_at DESC LIMIT 1");
        orderId = fr.rows[0]?.id;
      }
      if (!orderId) return res.status(404).json({ error: 'no order found' });
      const order = await getParticle(orderId);
      if (!order) return res.status(404).json({ error: 'order not found' });
      const p = order.payload || {};
      // 履约节点：依据订单状态推导里程碑（node/plan/actual/status）
      const MILESTONES = {
        shipped: [
          { plan: '生产备货 T+3', actual: 'T+3', status: '已完成' },
          { plan: '物流发货 T+7', actual: 'T+7', status: '已完成' },
          { plan: '客户签收 T+10', actual: 'T+9', status: '已完成' },
        ],
        completed: [
          { plan: '生产备货 T+3', actual: 'T+3', status: '已完成' },
          { plan: '物流发货 T+7', actual: 'T+7', status: '已完成' },
          { plan: '客户签收 T+10', actual: 'T+10', status: '已完成' },
          { plan: '回款核销 T+30', actual: 'T+28', status: '已完成' },
        ],
        default: [
          { plan: '生产备货', actual: '—', status: '待开始' },
          { plan: '物流发货', actual: '—', status: '待开始' },
          { plan: '客户签收', actual: '—', status: '待开始' },
        ],
      };
      const nodes = MILESTONES[p.status] || MILESTONES.default;
      const data = {
        components: {
          'attr-field': {
            order_no: { value: p.order_no || order.slug || '' },
            order_amount: { value: p.amount ?? '' },
          },
          'subtable': {
            '履约节点': { rows: [{ node: '订单履约节点', nodes }] },
          },
          'goal-form': {},
        },
      };
      const rendered = renderPage(S10_SCHEMA, data);
      res.json({ schema: S10_SCHEMA, data, html: rendered.html, warnings: rendered.warnings, orderId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S11 回款详情 受控渲染（复刻 S08/S09/S10：交易单据详情族，专用路由 + renderPage 注入真实数据）───
  // 契约：GET /api/page/payment-detail?paymentId= → { schema:S11, data, html }；html 为 renderPage 产物
  // 真实数据面：回款计划粒子(id) + 关联回款记录(subtable 计划 vs 实收：paid/gap/status)
  app.get('/api/page/payment-detail', async (req, res) => {
    try {
      // 修复（2026-09-01）：同 deal-detail —— 关联回款记录查询引用未声明的 me → 端点恒 500
      let me;
      try { me = resolveMe(req); } catch { me = { ok: false }; }
      let paymentId = req.query.paymentId || req.query.id;
      if (!paymentId) {
        const fr = await query("SELECT id FROM crm.particles WHERE type='CRM_PAYMENT_PLAN' ORDER BY created_at DESC LIMIT 1");
        paymentId = fr.rows[0]?.id;
      }
      if (!paymentId) return res.status(404).json({ error: 'no payment plan found' });
      const plan = await getParticle(paymentId);
      if (!plan) return res.status(404).json({ error: 'payment plan not found' });
      const p = plan.payload || {};
      // 关联回款记录：同 contract_id 的 CRM_PAYMENT_RECORD
      const records = await queryParticles({ type: 'CRM_PAYMENT_RECORD', tenantId: scopeTenant(me), limit: 100 }).catch(() => []);
      const linked = records.filter(r => r.payload?.contract_id === p.contract_id);
      const totalPaid = linked.reduce((s, r) => s + (Number(r.payload?.paid_amount) || 0), 0);
      const data = {
        components: {
          'attr-field': {
            payment_no: { value: plan.slug || paymentId },
            due_amount: { value: p.plan_amount ?? '' },
            paid_amount: { value: totalPaid },
          },
          'subtable': {
            '计划 vs 实收': {
              rows: [{
                plan: plan.title || plan.slug || '回款计划',
                records: linked.map(r => ({
                  paid: r.payload?.paid_amount ?? '',
                  gap: (Number(p.plan_amount) || 0) - (Number(r.payload?.paid_amount) || 0),
                  status: r.state || '',
                })),
              }],
            },
          },
          'goal-form': {},
        },
      };
      const rendered = renderPage(S11_SCHEMA, data);
      res.json({ schema: S11_SCHEMA, data, html: rendered.html, warnings: rendered.warnings, paymentId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S12 发票详情 受控渲染（复刻 S08/S09/S10/S11：交易单据详情族，专用路由 + renderPage 注入真实数据）───
  // 契约：GET /api/page/invoice-detail?invoiceId= → { schema:S12, data, html }；html 为 renderPage 产物
  // 真实数据面：getParticle(invoiceId)（无 id → 取首条 CRM_INVOICE，防空白回归）
  //            attr-field：invoice_no ← payload.invoice_no / invoice_amount ← payload.invoice_amount
  //            reconciled ← payload.reconcile_status 派生（reconciled→已对账；其余→未对账）
  // 角色：finance 主；goal-form 对账入口（POST /api/page/from-nl）
  app.get('/api/page/invoice-detail', async (req, res) => {
    try {
      // 修复（2026-09-01）：同上 —— 缺省发票查询引用未声明的 me → 端点恒 500
      let me;
      try { me = resolveMe(req); } catch { me = { ok: false }; }
      const invoiceId = req.query.invoiceId;
      let invoice = null;
      if (invoiceId) {
        invoice = await getParticle(invoiceId);
      } else {
        const rows = await queryParticles({ type: 'CRM_INVOICE', tenantId: scopeTenant(me), limit: 1 }).catch(() => []);
        invoice = rows[0] || null;
      }
      if (!invoice) {
        res.status(404).json({ error: '发票不存在', invoiceId });
        return;
      }
      const p = invoice.payload || {};
      const reconciled = p.reconcile_status === 'reconciled';
      const data = {
        components: {
          'attr-field': {
            invoice_no: { value: p.invoice_no || invoice.slug || invoiceId || '' },
            invoice_amount: { value: p.invoice_amount ?? '' },
            reconciled: { value: reconciled ? '已对账' : '未对账' },
          },
          'goal-form': {},
        },
      };
      const rendered = renderPage(S12_SCHEMA, data);
      res.json({ schema: S12_SCHEMA, data, html: rendered.html, warnings: rendered.warnings, invoiceId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S04 智能体监控台 受控渲染（复刻 S02/S03/S05/S06/S07：专用路由 + renderPage 注入真实数据）───
  // 契约：GET /api/page/particle-detail? → { schema:S13, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 契约：GET /api/page/particle-detail? → { schema:S13, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 修正（冒烟发现）：① queryParticles 返回裸数组（非 {items}）；② 其签名忽略 id/ids 过滤，
  //    取单粒子必须走 getParticle(id)（按 id 精确命中）；③ renderer 的 resolveDatum 只读 data.components[kind]，
  //    故 data 必须按 components 索引构造（attr-field:slug→{value}；subtable:{rows}），否则值/出边不渲染。
  app.get('/api/page/particle-detail', async (req, res) => {
    const me = resolveMe(req);
    try {
      const id = req.query.id;
      let particle = null;
      if (id) {
        particle = await getParticle(id); // 按 id 精确命中（queryParticles 忽略 id 过滤）
      } else {
        const rows = await queryParticles({ tenantId: scopeTenant(me), limit: 100 }).catch(() => []);
        // 无 id 默认取首粒子（防空白回归）；优先展示一个 CRM_DEAL 作为代表性样例
        particle = rows.find(r => r.type === 'CRM_DEAL') || rows[0] || null;
      }
      if (!particle) return res.status(404).json({ error: 'particle not found' });
      const [{ rows: outEdges }] = await Promise.all([
        query(`SELECT edge_type, target_type, target_id, meta FROM crm.edges WHERE tenant_id=$1 AND source_id=$2`, ['system', particle.id]),
      ]);
      const targets = outEdges.length
        ? (await query(`SELECT * FROM crm.particles WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, ['system', outEdges.map(e => e.target_id)])).rows
        : [];
      const detail = buildParticleDetail(particle, outEdges, targets);
      const { ok, schema, errors } = buildParticleDetailSchema(detail);
      if (!ok) return res.status(500).json({ error: errors[0] });
      // data 按 renderer resolveDatum 契约：components[kind] 索引
      const payload = particle.payload || {};
      const attrFields = {};
      for (const [slug, value] of Object.entries(payload)) {
        if (['events', 'ai'].includes(slug) || String(slug).startsWith('ai.')) continue;
        attrFields[slug] = { value };
      }
      const subtableRows = outEdges.map(e => ({
        edgeType: e.edge_type ?? e.edgeType,
        edges: [{ targetType: e.target_type ?? e.targetType, targetId: e.target_id ?? e.targetId }],
      }));
      const data = {
        components: {
          'attr-field': attrFields,
          'subtable': { rows: subtableRows },
        },
        // 透传（前端壳页可能引用）
        particle, outEdges, edges: outEdges, related: Object.fromEntries(targets.map(t => [t.id, t.payload?.name || t.payload?.title || t.id])),
      };
      const rendered = renderPage(schema, data);
      res.json({ schema, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── S21 方法论 SKILL 注册表 受控渲染（复刻 S15 范式：受控 schema + renderPage 出片）───
  // 契约：GET /api/page/skill-registry → { schema:S21, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 数据面：listSkillRegistry() 返回 [{skill_id, category, enabled, rbac_roles, methodology_id, source}]；
  //   table 注入真实 SKILL 行（skill_id/category/enabled/rbac_roles），select 注入启停/角色选项
  app.get('/api/page/skill-registry', async (req, res) => {
    try {
      const skills = await listSkillRegistry().catch(() => []);
      const rows = skills.map(s => ({
        skill_id: s.skill_id, category: s.category, enabled: s.enabled,
        rbac_roles: (s.rbac_roles || []).join(', '), methodology_id: s.methodology_id || '',
        source: s.source || 'skill',
      }));
      const data = {
        components: {
          table: { rows },
          select: {
            启用开关: { options: ['启用', '停用'] },
            'RBAC 角色': { options: ['sales', 'manager', 'admin'] },
          },
        },
      };
      const rendered = renderPage(S21_SCHEMA, data);
      res.json({ schema: S21_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 契约：GET /api/page/agent-dashboard → { schema:S04, data, html }；html 为 renderPage 产物（pg-page 顶层）
  // 真实数据面：agentSpecs 装配(健康) + board 待审批(submitted) + /api/monitor/decisions(决策覆盖) + kanban 任务流(告警/单Agent任务)
  // 注：/agents 已被并行线手写监控台占用，本路由为 S04 schema 的受控 renderPage 变体，路径独立不冲突
  app.get('/api/page/agent-dashboard', async (req, res) => {
    const me = resolveMe(req);
    try {
      const asm = await assertAgentAssembly();
      const agentKeys = Object.keys(agentSpecs);
      const board = await (async () => {
        try {
          const types = ['CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_INVOICE', 'CRM_ORDER'];
          const items = [];
          for (const t of types) { const rows = await queryParticles({ type: t, tenantId: scopeTenant(me), limit: 100 }).catch(() => []); items.push(...rows); }
          const grouped = {}; for (const p of items) (grouped[p.type] ||= []).push(p);
          const submitted = types.reduce((n, t) => n + (grouped[t] || []).filter(x => x.payload?.status === 'submitted').length, 0);
          return { submitted };
        } catch { return { submitted: 0 }; }
      })();
      const decisions = await (async () => {
        try { const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/monitor/decisions'); const j = await r.json(); return Array.isArray(j.decisions) ? j.decisions.length : 0; } catch { return 0; }
      })();
      const tasks = await listTasks({ tenantId: scopeTenant(me) });
      // 告警：装配失败断言 + 任务级异常
      const alerts = [];
      for (const r of (asm?.results || [])) if (!r.ok) alerts.push({ agent: r.agent || '—', level: 'error', message: r.detail || '装配失败', ts: new Date().toISOString().slice(0, 19) });
      for (const t of tasks) if (t.status === 'failed' || t.status === 'timeout') alerts.push({ agent: t.owner || '—', level: 'warn', message: `任务 ${t.id} ${t.status}`, ts: String(t.created_at || '').slice(0, 19) });
      // 单 Agent 任务流：按 owner 分组
      const byAgent = {};
      for (const t of tasks) { const a = t.owner || 'unassigned'; (byAgent[a] ||= []).push(t); }
      const flowRows = Object.entries(byAgent).map(([agent, ts]) => ({
        agent,
        tasks: ts.slice(0, 8).map(t => ({ task: t.title || t.action_name || t.step || t.id, status: t.status || '—', sla: t.sla || '—' })),
      }));
      const data = {
        components: {
          'metric-card': {
            'Agent 健康': { value: `${agentKeys.length} 个在线` },
            '待审批': { value: `${board.submitted} 单` },
            '决策覆盖': { value: `${decisions} 场景` },
          },
          table: { rows: alerts.map(a => ({ agent: a.agent, level: a.level, message: a.message, ts: a.ts })) },
          subtable: { rows: flowRows },
        },
      };
      const rendered = renderPage(S04_SCHEMA, data);
      res.json({ schema: S04_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── 门户 NL→Page（子系统四 T6：pageStore 生命周期 + 唯一渲染出口）───
  // 顶部静态 import（18 行）已提供 createPageFromNl/listPages/publishPage/revertPage/getPageHtml，
  // 此处无需再解构；函数保持同步、无顶层 await（Rollup 编译安全）。

  // NL → draft 页面（guardrails→parse→validate→render 全链；不入库，内存内存 Map）
  app.post('/api/page/from-nl', async (req, res) => {
    const { nl } = req.body || {};
    const r = createPageFromNl(nl);
    if (!r.ok) return res.status(400).json({ error: r.error, errors: r.errors, needsClarification: r.needsClarification });
    // 对话驱动建议（2026-09-08 T7）：把 NL 原文当销售诉求定位决策坐标（原文不落库，仅用于规则匹配）
    let advice = null;
    try {
      const a = await advise({ utterance: String(nl || ''), ctx: {}, deal: null, stage: null });
      advice = a.advice;
    } catch { advice = null; }
    res.status(201).json({ page_id: r.page_id, schema: r.schema, confidence: r.confidence, needsClarification: r.needsClarification, previewHtml: r.previewHtml, advice });
  });

  // 页面清单（draft/published 摘要）
  app.get('/api/pages', async (req, res) => {
    res.json({ items: listPages() });
  });

  // 显式发布（draft→published；已 published 幂等）
  app.post('/api/page/:id/publish', async (req, res) => {
    const r = publishPage(req.params.id);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json({ ok: true, ...r });
  });

  // 回退（published→draft）
  app.post('/api/page/:id/revert', async (req, res) => {
    const r = revertPage(req.params.id);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json({ ok: true, ...r });
  });

  // 预览渲染（唯一渲染出口 renderPage）
  app.get('/api/page/:id/preview', async (req, res) => {
    const r = getPageHtml(req.params.id);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json({ ok: true, html: r.html, warnings: r.warnings });
  });

  // 记忆蒸馏端点（dryRun 返回待蒸馏计数，不写；默认执行蒸馏：标 distilled 非删除）
  app.post('/api/memory/distill', async (req, res) => {
    const dryRun = req.query.dryRun === '1' || req.body?.dryRun;
    if (dryRun) {
      // dryRun：仅返回待蒸馏计数，不写
      const r = await query(`SELECT count(*)::int AS n FROM crm.memory_log WHERE archived=false AND distilled=false AND created_at < now() - '30 days'::interval`);
      return res.json({ dryRun: true, wouldDistill: r.rows[0].n });
    }
    const d = await distillMemory({ ttlDays: 30 });
    res.json({ ok: d.ok });
  });

  // SSE 事件总线（单连接 5 域）
  app.get('/events', (req, res) => hub.connect(res));

  // ─── 销售决策监控聚合 API（任务 4：7 闸门闭环监控读端点）───
  // 2026-09-03：页面 HTML 公开（浏览器直链不带 Authorization）、数据面 admin 守卫。
  //   归属「仅 admin 监控台」的端点逐一 requireAdminRole；auditability* 公开端点（/agents 跨角色消费）除外。
  // T13 租户隔离（2026-09-04）：监控聚合按租户过滤——
  //   显式 ?tenant_id= 优先（仅 admin 可指定，普通用户忽略，防越权）；
  //   否则按 scopeTenant(me)（admin→'*' 全量，普通用户→自身租户）；
  //   缺省 '*'=全量，现状行为完全兼容（当前库中决策全为 system 租户）。
  function tenantFilter(req, me) {
    const explicit = String(req.query?.tenant_id || '').trim();
    if (explicit) {
      const sc = me && scopeTenant(me);
      if (sc === '*') return explicit; // 仅 admin 通配可指定租户
      return sc === '*' ? explicit : sc; // 普通用户忽略显式参数（防越权读他租户）
    }
    return (me && scopeTenant(me)) || '*';
  }
  app.get('/api/monitor/gates', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      const tt = tenantFilter(req, resolveMe(req) || undefined);
      const gates = [];
      for (const s of GATE_SCENARIOS) {
        const metrics = await getGateMetrics({ scenario_id: s, tenantId: tt });
        const coverage = await getSevenDimCoverage({ scenario_id: s, tenantId: tt });
        gates.push({ scenario_id: s, metrics, coverage });
      }
      res.json({ gates });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── 平台运营洞察聚合端点（2026-09-05 设计 §2.1-2.3；admin/sysadmin 只读）───
  app.get('/api/monitor/agent-summary', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      const { getAgentSummary } = await import('../monitor/monitorStore.js');
      const days = Number(req.query.days || 7) || 7;
      const me = resolveMe(req);
      const tenantId = me?.ok ? me.tenantId : 'system';
      res.json(await getAgentSummary({ days, tenantId }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/monitor/decision-health', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      const { getDecisionHealth } = await import('../monitor/monitorStore.js');
      const days = Number(req.query.days || 30) || 30;
      const me = resolveMe(req);
      const tenantId = me?.ok ? me.tenantId : 'system';
      res.json(await getDecisionHealth({ days, tenantId }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/param-diagnosis', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      const { getParamDiagnosis } = await import('../monitor/diagnosis.js');
      const days = Number(req.query.days || 7) || 7;
      res.json(await getParamDiagnosis({ days }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/monitor/decisions', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      const { scenario_id } = req.query;
      const items = await getDecisionList({ scenario_id: scenario_id || null, tenantId: tenantFilter(req, resolveMe(req) || undefined) });
      // Phase4 A-T6 Layer1 列：附 supplied_dims(N/7) + audit4q(N/4)；增量字段，兼容旧消费者
      const ids = (items || []).map((d) => d.decision_id).filter(Boolean);
      const suppliedMap = await getSnapshotSuppliedMap(ids).catch(() => new Map());
      const enriched = await Promise.all((items || []).map(async (d) => {
        let audit4q = null;
        try { const r = await computeAudit4q(d.decision_id); audit4q = r ? { score: r.health.score, statuses: r.health.statuses } : null; } catch { audit4q = null; }
        return { ...d, supplied_dims: suppliedMap.get(d.decision_id) ?? null, audit4q };
      }));
      res.json({ items: enriched });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Phase4 A-T6 Layer0「上下文供给 N/7」单一事实源：平台级真实供给健康（双口径防假绿）
  app.get('/api/monitor/supply-health', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      res.json(await getPlatformSupplyHealth());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Phase4 A-T6 Layer2 页签②「当时的上下文」：读某决策最新上下文供给快照（逐字 prompt + 操作级溯源）
  // 惰性装配：若该决策尚无快照（首次查看），按需补跑 S1–S7 装配并落库（fail-open），再读回——避免每次建决策都重装配。
  // Q7：sysadmin/admin 角色判定（调试端点复用口径，兼容实际角色 'admin'）
  function roleIsAdmin(me) { return me?.role === 'admin' || me?.role === 'sysadmin'; }

  app.get('/api/decision/:id/context-snapshot', async (req, res) => {
    const me = requireMe(req, res); if (!me) return;
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    try {
      const snap = await getDecisionContextSnapshot(req.params.id);
      if (snap) return res.json(snap);
      // Q7：无快照时仅 sysadmin/admin 可触发惰性装配（调试用）；普通用户纯只读 → 404 提示
      if (!roleIsAdmin(me)) {
        return res.status(404).json({ error: '快照未生成，需 sysadmin 触发装配', decision_id: req.params.id, action: 'context-reassemble' });
      }
      try {
        const { getDecision } = await import('../decision/decisionRepo.js');
        const d = await getDecision(req.params.id);
        if (d) {
          const { assembleContextV2 } = await import('../context/assembleContextV2.js');
          const ents = Array.isArray(d.involved_entities) ? d.involved_entities : [];
          const acctId = ents.map((e) => (e && typeof e === 'object' ? e.account_id : null)).filter(Boolean)[0] || null;
          await assembleContextV2({
            decision_id: d.decision_id, actor: d.decider_id || null,
            scenario_id: d.scenario_id, account_id: acctId, entities: ents,
            trigger_context: d.trigger_context || {}, tenant_id: d.tenant_id || 'system',
          }).catch(() => {});
          const fresh = await getDecisionContextSnapshot(req.params.id);
          if (fresh) return res.json(fresh);
        }
      } catch { /* 装配失败不影响返回 404 */ }
      return res.status(404).json({ error: '该决策无上下文供给快照', decision_id: req.params.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Q7：sysadmin/admin 主动触发装配（调试用）；普通用户禁止（403）→ 满足「调试用仅 sysadmin 可调」
  app.post('/api/decision/:id/context-reassemble', async (req, res) => {
    const me = requireMe(req, res); if (!me) return;
    if (!roleIsAdmin(me)) return res.status(403).json({ error: '需要 sysadmin 权限' });
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    try {
      const { getDecision } = await import('../decision/decisionRepo.js');
      const d = await getDecision(req.params.id);
      if (!d) return res.status(404).json({ error: '决策不存在', decision_id: req.params.id });
      const { assembleContextV2 } = await import('../context/assembleContextV2.js');
      const ents = Array.isArray(d.involved_entities) ? d.involved_entities : [];
      const acctId = ents.map((e) => (e && typeof e === 'object' ? e.account_id : null)).filter(Boolean)[0] || null;
      await assembleContextV2({
        decision_id: d.decision_id, actor: d.decider_id || null,
        scenario_id: d.scenario_id, account_id: acctId, entities: ents,
        trigger_context: d.trigger_context || {}, tenant_id: d.tenant_id || 'system',
      });
      const snap = await getDecisionContextSnapshot(req.params.id);
      if (!snap) return res.status(500).json({ error: '装配完成但快照读取失败' });
      res.json({ reassembled: true, snapshot: snap });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/monitor/coverage', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    try {
      const { scenario_id } = req.query;
      if (!scenario_id) return res.status(400).json({ error: 'scenario_id required' });
      res.json({ coverage: await getSevenDimCoverage({ scenario_id, tenantId: tenantFilter(req, resolveMe(req) || undefined) }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── 决策网络查询：统一处理层（canonical 实现，graph/* 与 monitor/* 共用，单一事实源）───
  // 收敛端点重复债（2026-08-26）：此前 /api/monitor/{trace,impact,audit} 与 /api/graph/{trace,impact,provenance}
  // 各自直连同服务层、仅路径风格不同 → 双改易漂移。现 /api/graph/* 为权威只读查询面，
  // /api/monitor/* 标记 deprecated 并复用本处理层（薄转发，不删端点，可回滚）。
  // T11：graph/* 补全鉴权（与 calibration 同口径 requireMe），杜绝 §0 断点 4 匿名访问。
  function requireMe(req, res) {
    const me = resolveMe(req);
    if (!me?.ok) { res.status(401).json({ error: '未登录' }); return null; }
    return me;
  }
  // T5 多租户：决策归属校验（普通用户只能操作/读取本租户决策；admin/sysadmin 通配 '*' 可见全部）
  // 返回 true=有权；false=跨租户或不存在（调用方应回 403）
  async function assertDecisionTenant(id, me) {
    const sc = scopeTenant(me);
    if (sc === '*') return true; // 平台管理员跨租户
    const r = await query(`SELECT 1 FROM crm.decision WHERE decision_id=$1 AND tenant_id=$2`, [id, sc]);
    return r.rows.length > 0;
  }
  async function graphTraceHandler(decisionId, { maxDepth = 4 } = {}) {
    const upstream = await traceDecision(decisionId, { direction: 'upstream', maxDepth });
    const downstream = await traceDecision(decisionId, { direction: 'downstream', maxDepth });
    // T11：附加 decision_relation 的 7 类 typed 边（权威 PG 读；AGE 关时仍可查全 7 类）
    const typedEdges = await listTypedEdges(decisionId, { direction: 'both' }).catch(() => []);
    return { decision_id: decisionId, upstream, downstream, typedEdges };
  }
  async function graphImpactHandler(decisionId, { maxDepth = 4 } = {}) {
    return getImpact(decisionId, { maxDepth });
  }
  async function graphProvenanceHandler(decision_id) {
    return exportAudit({ decision_id });
  }

  // ─── 方法论 SKILL → DB 镜像 写时同步（§6.6 单一事实源纪律；审计/运维端点）───
  // 触发：任意改动了 skills/method-*/methodology.json 后，调用本端点把 SKILL 事实源增量同步进
  // methodology_template / methodology_dimension 镜像表（引擎消费点）。保守策略：只增补缺失，不覆盖既有。
  // 注：methodologySync 用函数内动态 import（懒加载）——顶层 await import 在非 async 模块作用域会触发
  //     Rollup「await isn't allowed in non-async function」解析失败（真实 bug，曾致 test/http.test.js 套件加载失败）。
  app.get('/api/methodology/skew', async (req, res) => {
    try {
      const { listMethodologySkew } = await import('../skills/methodologySync.js');
      res.json({ skew: await listMethodologySkew() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/methodology/sync', async (req, res) => {
    try {
      const { syncAllMethodologies } = await import('../skills/methodologySync.js');
      const { dryRun } = req.query || {};
      const results = await syncAllMethodologies({ dryRun: dryRun === '1' });
      res.json({ results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 决策网络视图 API（C2/C4）— DEPRECATED：薄转发至 /api/graph/*（不删端点，可回滚）
  // G7：DEPRECATED 薄转发同为只读溯源面，必须与 /api/graph/* 等价鉴权（杜绝匿名旁路）
  app.get('/api/monitor/trace/:decisionId', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    if (!requireMe(req, res)) return;
    try {
      const { direction = 'upstream', max_depth = 3 } = req.query;
      const { upstream, downstream } = await graphTraceHandler(req.params.decisionId, { maxDepth: Number(max_depth) });
      const chain = direction === 'downstream' ? downstream : upstream;
      res.set('Deprecation', 'true');
      res.set('Link', '</api/graph/trace>; rel="deprecated-alternative"');
      res.json({ decision_id: req.params.decisionId, chain });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/monitor/impact/:decisionId', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    if (!requireMe(req, res)) return;
    try {
      const map = await graphImpactHandler(req.params.decisionId, { maxDepth: Number(req.query.max_depth || 3) });
      res.set('Deprecation', 'true');
      res.set('Link', '</api/graph/impact>; rel="deprecated-alternative"');
      res.json(map);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/monitor/audit', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    if (!requireMe(req, res)) return;
    try {
      const { decision_id } = req.query;
      if (!decision_id) return res.status(400).json({ error: 'decision_id required' });
      const report = await graphProvenanceHandler(decision_id);
      res.set('Deprecation', 'true');
      res.set('Link', '</api/graph/provenance>; rel="deprecated-alternative"');
      res.json(report);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── 校准 P0：人工处置回写（HITL 闭环采集点；被调量 = human_disposition vs disposition）───
  // 铁律：处置动作不新建 decision（避免自引用）；审计复用被处置决策自身 id（audit_event.decision_id 列）。
  // 只写 human_* 四列，绝不覆写 decider_type/decider_id/decider_role（决策来源溯源凭据，P1 覆写率靠它筛自主样本）。
  app.post('/api/decisions/:id/disposition', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: '未登录' });
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    const { disposition, note } = req.body || {};
    try {
      const r = await recordHumanDisposition(req.params.id, {
        disposition,
        by_id: me.username || me.display_name || 'user',
        by_role: me.role,
        note,
      });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      res.json({ ok: true, decision: r.decision, overridden: r.overridden, state: r.next_state });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── T16 J2 反馈回路：业务结果手动补录（幂等写；第0闸经 MCP 写工具体现，此处直连回写）───
  app.post('/api/decision/:id/outcome', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: '未登录' });
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    const { outcome_type, source = 'manual', payload = {} } = req.body || {};
    if (!outcome_type) return res.status(400).json({ error: 'outcome_type required' });
    try {
      const row = await writeOutcome(req.params.id, {
        outcome_type,
        source,
        payload,
        created_by: me.username || me.display_name || 'user',
      });
      res.json({ ok: true, outcome: row });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ─── T16 J2 反馈回路：单决策业务结果读取（幂等键查询，供巡检卡/页面渲染）───
  app.get('/api/decision/:id/outcome', async (req, res) => {
    const me = requireMe(req, res); if (!me) return;
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    try { res.json(await listOutcomes(req.params.id)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── T16 J2 反馈回路：闸门业务结果聚合（决策通过率 vs 业务成功率 + 隐性错误簇）───
  app.get('/api/monitor/gate-outcome', (req, res, next) => requireAdminRole(req, res, next), async (req, res) => {
    if (!requireMe(req, res)) return;
    const { scenario_id } = req.query;
    if (!scenario_id) return res.status(400).json({ error: 'scenario_id required' });
    const me = resolveMe(req);
    try { res.json(await getGateOutcome(scenario_id, { tenantId: tenantFilter(req, me || undefined) })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── T30 溯源面板后端：四层溯源链 J→M→K→粒子库 + 七类根因（J3 归因条数据源）───
  app.get('/api/decision/:id/trace', async (req, res) => {
    const me = requireMe(req, res); if (!me) return;
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    try {
      const t = await traceRootCause(req.params.id);
      if (!t) return res.status(404).json({ error: 'decision 不存在' });
      const attr = t.layer_j.attribution || {};
      const root_cause = classifyRootCause({
        feedback: attr.feedback || {},
        attribution: { required_fill: attr.required_fill, edge_compliance: t.edge_compliance },
        particleChecks: t.particle_checks,
      });
      res.json({ trace: t, root_cause });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── T-D6 单决策三图闭环聚合（K/M/J 区 + crossLoopMap D1-D5 + provenance）───
  app.get('/api/decision/:id/closure', async (req, res) => {
    const me = requireMe(req, res); if (!me) return;
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    try {
      const { getDecisionClosure } = await import('../decision/closure.js');
      const data = await getDecisionClosure(req.params.id);
      if (!data) return res.status(404).json({ error: 'decision 不存在' });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── T26 J2 结构化业务反馈回写（可用性 + 偏差严重度，金律18 滞后业务信号）───
  app.post('/api/decision/:id/feedback', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: '未登录' });
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    const fb = req.body && req.body.feedback;
    if (!fb || typeof fb !== 'object') return res.status(400).json({ error: 'feedback object required' });
    try {
      const r = await setDecisionFeedback(req.params.id, fb, { created_by: me.username || me.display_name || 'user' });
      res.json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ─── P8 决策图查询 REST 面（对外/办公智能体只读查询；与 /api/monitor/* 并列，统一读直连纪律）───
  // 邻居边 + 解析邻居粒子摘要（实体级关联网络，读 edges 表 + 粒子详情）
  app.get('/api/graph/neighbors', async (req, res) => {
    if (!requireMe(req, res)) return;
    const { entityId } = req.query;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    try {
      const [{ rows: edges }] = await Promise.all([
        query(
          `SELECT edge_type, source_id, source_type, target_id, target_type, meta
           FROM crm.edges WHERE tenant_id=$1 AND (source_id=$2 OR target_id=$2) LIMIT 100`,
          ['system', entityId]),
      ]);
      const otherIds = [...new Set(edges.map((e) => (e.source_id === entityId ? e.target_id : e.source_id)))];
      const neighbors = otherIds.length
        ? (await query(
            `SELECT id, type, title, state, payload FROM crm.particles WHERE tenant_id=$1 AND id = ANY($2::uuid[]) LIMIT 100`,
            ['system', otherIds])).rows
        : [];
      res.json({ entity_id: entityId, edges, neighbors });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 决策因果链（上游=为什么 / 下游=导致了什么），降级回 ctePrecedents 递归 CTE（canonical 只读查询面）
  app.get('/api/graph/trace', (req, res) => {
    if (!requireMe(req, res)) return;
    const { decisionId } = req.query;
    if (!decisionId) return res.status(400).json({ error: 'decisionId required' });
    graphTraceHandler(decisionId, { maxDepth: Number(req.query.max_depth || 4) })
      .then((r) => res.json(r))
      .catch((e) => res.status(500).json({ error: e.message }));
  });

  // 决策影响地图（下游全节点 + 深度 + 边）
  app.get('/api/graph/impact', (req, res) => {
    if (!requireMe(req, res)) return;
    const { decisionId } = req.query;
    if (!decisionId) return res.status(400).json({ error: 'decisionId required' });
    graphImpactHandler(decisionId, { maxDepth: Number(req.query.max_depth || 4) })
      .then((r) => res.json(r))
      .catch((e) => res.status(500).json({ error: e.message }));
  });

  // 决策 PROV-O 溯源审计（链完整性 + 条目 + 上下游 + 引用先例），只读
  app.get('/api/graph/provenance', (req, res) => {
    if (!requireMe(req, res)) return;
    const { decision_id } = req.query;
    if (!decision_id) return res.status(400).json({ error: 'decision_id required' });
    graphProvenanceHandler(decision_id)
      .then((r) => res.json(r))
      .catch((e) => res.status(500).json({ error: e.message }));
  });

  // T11：7 类决策边权威查询（供 Cytoscape 真图渲染）；来源 crm.decision_relation（PG 权威，AGE 仅镜像）
  app.get('/api/graph/edges', (req, res) => {
    if (!requireMe(req, res)) return;
    const { entityId, direction = 'both' } = req.query;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    listTypedEdges(entityId, { direction })
      .then((edges) => res.json({ entity_id: entityId, direction, edges }))
      .catch((e) => res.status(500).json({ error: e.message }));
  });

  // P6 图分析（度数中心度 + 下游影响规模；AGE 主路 + 降级 CTE，与既有降级纪律一致）
  app.get('/api/graph/analytics', async (req, res) => {
    if (!requireMe(req, res)) return;
    const { decisionId, max_depth = 4 } = req.query;
    if (!decisionId) return res.status(400).json({ error: 'decisionId required' });
    try {
      const { degreeCentrality, downstreamImpactSize } = await import('../decision/graphAnalytics.js');
      const [degree, impact] = await Promise.all([
        degreeCentrality(decisionId),
        downstreamImpactSize(decisionId, { maxDepth: Number(max_depth) || 4 }),
      ]);
      res.json({ decision_id: decisionId, degree, impact });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // T-AUDIT4Q：决策可审计性「4 问验证」聚合（单一事实源复用 trace/impact/provenance/conflict）
  // Q1 解释直接原因=graphTraceHandler / Q2 追溯到源头=graphProvenanceHandler / Q3 发现冲突事实=detectConflicts / Q4 看下游影响=graphImpactHandler
  // 返回 health（可审计性 N/4）+ 四问逐条 status，供 sales-decision-monitor「4 问审计」看板与回归套件复用
  // 单一事实源：computeAudit4q/aggregateAuditability 已抽取至 src/decision/auditability.js（2026-08-31 物化设计 §4），
  // 端点/物化/A9 共用，评分口径永不漂移；本文件仅剩薄转发。
  app.get('/api/decision/:id/audit-4q', async (req, res) => {
    const me = requireMe(req, res); if (!me) return;
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'decision id required' });
    try {
      const r = await computeAudit4q(id);
      if (!r) return res.status(404).json({ error: 'decision not found' });
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 面板B「源头溯源」Turtle 导出（W3C PROV-O RDF）；复用 exportAudit + exportTurtle 单一事实源
  app.get('/api/decision/:id/provenance-turtle', async (req, res) => {
    const me = requireMe(req, res); if (!me) return;
    if (!await assertDecisionTenant(req.params.id, me)) return res.status(403).json({ error: '无权访问该租户决策' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'decision id required' });
    try {
      const d = await getDecision(id);
      if (!d) return res.status(404).json({ error: 'decision not found' });
      const prov = await exportAudit({ decision_id: id });
      const turtle = exportTurtle({
        decision_id: id,
        decision: prov.decision,
        entries: prov.entries || [],
        chainStatus: prov.chainStatus || 'UNKNOWN',
      });
      if (req.query.download === '1') {
        res.set('Content-Type', 'text/turtle; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="provenance-${id}.ttl"`);
        return res.send(turtle);
      }
      res.json({ decision_id: id, chain_status: prov.chainStatus, turtle });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 平台级「决策可审计性 SLA」聚合（公开，对齐 /api/monitor/* 家族只读口径）
  // 单一事实源：aggregateAuditability（src/decision/auditability.js）——扫近期决策逐项评分，
  // 聚合出可审计性百分比与四问分布；供 /agents SLA 看板呈现（G 系列问责闭环的平台级指标最后一公里）。
  app.get('/api/monitor/auditability', async (req, res) => {
    try {
      res.json(await aggregateAuditability({ limit: req.query.limit || 50 }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 可审计性 SLA 历史趋势（公开只读，对齐 /api/monitor/* 家族）：读 crm.agent_sla 物化快照
  // 消费方：/agents 趋势卡 + A9 闭环趋势监测（只读，不写粒子）；?days=30 上限 365
  app.get('/api/monitor/auditability/history', async (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);
      const rows = (await query(
        `SELECT measured_at, window_size, auditability_pct, full_count, with_conflict_count, tampered_count,
                q1_pass,q1_warn,q1_fail, q2_pass,q2_warn,q2_fail, q3_pass,q3_warn,q3_fail, q4_pass,q4_warn,q4_fail
         FROM crm.agent_sla
         WHERE measured_at >= now() - make_interval(days=>$1)
         ORDER BY measured_at DESC`,
        [days]
      )).rows.map((r) => ({
        measured_at: r.measured_at,
        window_size: r.window_size,
        auditability_pct: Number(r.auditability_pct),
        full_count: r.full_count,
        with_conflict_count: r.with_conflict_count,
        tampered_count: r.tampered_count,
        per_status: {
          Q1: { pass: r.q1_pass, warn: r.q1_warn, fail: r.q1_fail },
          Q2: { pass: r.q2_pass, warn: r.q2_warn, fail: r.q2_fail },
          Q3: { pass: r.q3_pass, warn: r.q3_warn, fail: r.q3_fail },
          Q4: { pass: r.q4_pass, warn: r.q4_warn, fail: r.q4_fail },
        },
      }));
      res.json({ days, count: rows.length, rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.use(createWorkbenchRouter({}));
  app.get('/workbench.html', (req, res) => res.redirect(301, '/my-todo.html'));
  app.get('/workbench', (req, res) => res.redirect(301, '/my-todo.html'));

  // 页面市场（方案 C 收口：33 受控 schema 枚举/预览 + 静态市场页）
  app.use(createPageMarketRouter({}));
  // 门户原型（Stage3 mockup 孤儿页挂路由；独立原型，非受控 schema，单独出口）
  app.get('/portal-stage3', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/portal-stage3-mockup.html', import.meta.url))));

  // 销售决策监控台（7 闸门闭环看板，静态）：治理/审计类页面，仅 admin 可达
  // 双保险：菜单已移入 ADMIN_MENU（sales 不可见）+ 路由 requireAdminRole（直链 403）
  // 页面 HTML 公开（与 users.html 等门户页一致）；权限由页面内 JS 角色控制 + 后端 API 鉴权双保险
  app.get('/sales-decision-monitor', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/sales-decision-monitor.html', import.meta.url))));
  app.get('/sales-decision-monitor.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/sales-decision-monitor.html', import.meta.url))));

  // 决策链可视化（P7：因果链/影响地图/审计导出的独立 SVG 看板）
  app.get('/decision-graph', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/decision-graph.html', import.meta.url))));
  app.get('/decision-graph.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/decision-graph.html', import.meta.url))));
  // S14 决策图谱 受控渲染页（经 /api/page/decision-graph 唯一出口；手写 /decision-graph 保留兼容）
  app.get('/decision-graph-board.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/decision-graph-board.html', import.meta.url))));
  app.get('/decision-graph-board', (req, res) => res.redirect('/decision-graph-board.html'));

  // 粒子详情页（12 文档 §7-2 前端数据来源展示：①/②/③/④ 来源徽标 + AI 置信度）—— 阶段3前台字段采集的观测面板（总体设计 §8.7）
  // 系统页 RBAC 守卫（Task 3：admin 独享；菜单藏 + 路由拦双保险）
  app.get('/particle-detail.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/particle-detail.html', import.meta.url))));
  app.get('/particle-detail-board.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/particle-detail-board.html', import.meta.url))));
  app.get('/agents.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/agents.html', import.meta.url))));
  app.get('/agents', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/agents.html', import.meta.url))));
  // 配置中心统一入口（只读聚合页：18 项配置三态总览）——加 no-store 头，确保 configCenter.js 即时刷新
  app.get('/config.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('../web/config.html', import.meta.url)));
  });
  app.get('/config', (req, res) => res.redirect('/config.html'));
  // P0-②：决策思维要素只读总览（8 大销售决策 × 八要素×九尺子）；前端 fetch GET /api/decision/thinking-templates
  app.get('/decision-thinking.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/decision-thinking.html', import.meta.url))));
  app.get('/decision-thinking', (req, res) => res.redirect('/decision-thinking.html'));
  // 场景路由配置页（融合设计批准 2026-09-02，configCenter id36）：展示/编辑 dims+scene_matrix+thresholds，读写 /api/config/context-routing
  app.get('/decision-route-config.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('../web/decision-route-config.html', import.meta.url)));
  });
  app.get('/decision-route-config', (req, res) => res.redirect('/decision-route-config.html'));
  app.get('/decision-precedent-config.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('../web/decision-precedent-config.html', import.meta.url)));
  });
  app.get('/decision-precedent-config', (req, res) => res.redirect('/decision-precedent-config.html'));
  // 审计链巡检配置页（configCenter id37，2026-09-03 建）：展示/编辑 enabled/interval_ms/limit，读写 /api/config/provenance-patrol
  app.get('/decision-provenance-patrol-config.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('../web/decision-provenance-patrol-config.html', import.meta.url)));
  });
  app.get('/decision-provenance-patrol-config', (req, res) => res.redirect('/decision-provenance-patrol-config.html'));
  app.get('/agent-config.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/agent-config.html', import.meta.url))));
  app.get('/agent-config', (req, res) => res.redirect('/agent-config.html'));
  app.get('/portal/agentConfigRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/agentConfigRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // L2C 业务闭环看板（item 方向1：门户级打通）
  app.get('/business-closure.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/business-closure.html', import.meta.url))));
  app.get('/business-closure', (req, res) => res.redirect('/business-closure.html'));
  app.get('/portal/businessClosureRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/businessClosureRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // S15 业务看板（L2C）受控渲染页（经 /api/page/business-board 唯一出口；业务闭环手写板保留兼容）
  app.get('/business-board.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/business-board.html', import.meta.url))));
  app.get('/business-board', (req, res) => res.redirect('/business-board.html'));
  // 7 类业务实体深链别名：复用 particle-detail.html（前端从 path 解析 type/id，见 bootstrapDetail）
  const detailAlias = (p) => app.get(p, (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/particle-detail.html', import.meta.url))));
  ['/deals/:id', '/quotes/:id', '/contracts/:id', '/orders/:id', '/payments/:id', '/invoices/:id', '/leads/:id'].forEach(detailAlias);
  // 业务 section 渲染模块（ESM，浏览器 + vitest 共用）
  // 门户运行时渲染器样式（页面渲染器输出 pg-* 类；根因修复：contract/order/payment 详情页引用缺失 → 补文件+路由）
  app.get('/portal/page.css', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/page.css', import.meta.url)), { headers: { 'Content-Type': 'text/css' } }));
  app.get('/portal/detailSections.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/detailSections.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/agentsPage.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/agentsPage.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/contractsPage.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/contractsPage.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  //   configCenter 模块（被 config.html 静态 import）——加 no-store 防 ESM 缓存导致 page 字段配置变更不生效
  app.get('/portal/configCenter.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('../portal/configCenter.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } });
  });
  //   configTabs 模块（§15 权限重分组 TAB 可见性，被 config.html 静态 import）——漏登记致 404 → config.html 整页空白
  app.get('/portal/configTabs.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('../portal/configTabs.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } });
  });
  app.get('/business-tier.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/business-tier.html', import.meta.url))));
  app.get('/business-tier', (req, res) => res.redirect('/business-tier.html'));
  app.get('/portal/businessTier.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/businessTier.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/businessTierRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/businessTierRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/calibrationRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/calibrationRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));

  // T12：第三方库离线 vendor 目录（Cytoscape 等），随仓库不依赖外部 CDN；仅静态读，无鉴权必要
  app.use('/portal/vendor', express.static(fileURLToPath(new URL('../web/portal/vendor', import.meta.url))));
  app.get('/rbac.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/rbac.html', import.meta.url))));
  app.get('/rbac', (req, res) => res.redirect('/rbac.html'));
  app.get('/portal/rbacMatrix.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/rbacMatrix.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/rbacMatrixRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/rbacMatrixRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 决策场景配置页（第 14 项）— admin 独享（Task 3）
  app.get('/decision-scenarios.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('../web/decision-scenarios.html', import.meta.url)));
  });
  app.get('/decision-scenarios', (req, res) => res.redirect('/decision-scenarios.html'));
  app.get('/portal/decisionScenario.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/decisionScenario.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/decisionScenarioRender.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('../portal/decisionScenarioRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } });
  });
  // 用户管理配置页（第 12 项）— admin 独享（Task 3）
  app.get('/users.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/users.html', import.meta.url))));
  app.get('/config/users', (req, res) => res.redirect('/users.html'));
  app.get('/portal/userManagement.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/userManagement.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/userManagementRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/userManagementRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 本体/词汇配置页（第 22 项）
  app.get('/ontology.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/ontology.html', import.meta.url))));
  app.get('/ontology', (req, res) => res.redirect('/ontology.html'));
  app.get('/portal/ontologyConfig.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/ontologyConfig.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/ontologyConfigRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/ontologyConfigRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 系统设置页（第 28 项）
  app.get('/system.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/system.html', import.meta.url))));
  app.get('/config/system', (req, res) => res.redirect('/system.html'));
  app.get('/portal/systemSettings.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/systemSettings.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/systemSettingsRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/systemSettingsRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 记忆/先例管理页（第 26 项）
  app.get('/memory.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/memory.html', import.meta.url))));
  app.get('/memory', (req, res) => res.redirect('/memory.html'));
  app.get('/portal/memoryConfig.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/memoryConfig.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/memoryConfigRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/memoryConfigRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 审批流配置页（第 17 项）— admin 独享（Task 3）
  app.get('/approval-flow.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/approval-flow.html', import.meta.url))));
  app.get('/approval-flow', (req, res) => res.redirect('/approval-flow.html'));
  app.get('/portal/approvalFlow.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/approvalFlow.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/approvalFlowRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/approvalFlowRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 预警规则配置页（第 21 项）— admin 独享（Task 3）
  app.get('/alert-rules.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/alert-rules.html', import.meta.url))));
  app.get('/alert-rules', (req, res) => res.redirect('/alert-rules.html'));
  app.get('/portal/alertRuleConfig.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/alertRuleConfig.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/alertRuleConfigRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/alertRuleConfigRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 客户跟踪告警复用渲染纯函数（2026-08-31 抽离：工作台 + 客户跟踪页共用）
  app.get('/portal/followReminder.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/followReminder.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 连接器/MCP 身份配置页（第 27 项）— admin 独享（Task 3）
  app.get('/mcp-identities.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/mcp-identities.html', import.meta.url))));
  app.get('/mcp-identities', (req, res) => res.redirect('/mcp-identities.html'));
  app.get('/portal/mcpIdentity.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/mcpIdentity.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/mcpIdentityRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/mcpIdentityRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 我的 API Key（个人只读页，方案 A docs/2026-09-05-my-api-keys-design.md）— 全员登录可达
  app.get('/my-api-keys.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/my-api-keys.html', import.meta.url))));
  app.get('/my-api-keys', (req, res) => res.redirect('/my-api-keys.html'));

  // 粒子属性元模型配置抽屉（G1 T6：受控 Schema 渲染，无第二套前端栈）
  app.get('/meta-attr-drawer', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/meta-attr-drawer.html', import.meta.url))));
  app.get('/meta-attr-drawer.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/meta-attr-drawer.html', import.meta.url))));

  // 任务看板（T4：含 awaiting_confirm 角色确认列 + 橙色待确认 badge）
  app.get('/kanban.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/kanban.html', import.meta.url))));

  // 智能体工作台（S03：真实数据受控渲染页；复刻 S02 出片范式）— admin 独享（Task 3）
  // 业务工作台（S03）：sales/manager 全员可用，非系统配置页 → 不挂 admin 守卫（与 todo/account-360/deal-detail 一致）
  app.get('/agent-workbench.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/agent-workbench.html', import.meta.url))));
  app.get('/agent-workbench', (req, res) => res.redirect('/agent-workbench.html'));
  // S03 schema navigation.to='/workspace' 别名（页面市场卡片链接可达，避免 404）
  app.get('/workspace', (req, res) => res.redirect('/agent-workbench.html'));

  // ─── Buddy 应用门户外壳（2026-09-05）：/portal/*.html 静态映射 src/web ───
  // 门户 iframe 复用既有页（account-360 / agent-workbench），胶囊注入对话区经同一 origin 派发。
  // 仅匹配 .html，不与下方 /portal/*.js（src/portal 模块）冲突。
  app.get(/^\/portal\/([\w-]+)\.html$/, (req, res) =>
    res.sendFile(fileURLToPath(new URL(`../web/${req.params[0]}.html`, import.meta.url))));
  app.get('/buddy', (req, res) => res.redirect('/portal/buddy-crm-portal.html'));

  // ─── S06 客户 360 静态页 + 别名（navigation.to='/accounts/:id'）───
  app.get('/account-360.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/account-360.html', import.meta.url))));
  app.get('/account-360', (req, res) => res.redirect('/account-360.html'));
  // 详情页路径别名：/accounts/:id 直接服务 account-360.html（前端从 path 解析 accountId）
  app.get('/accounts/:id', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/account-360.html', import.meta.url))));

  // ─── S35 客户洞察 已合并入 account-360（双 Tab）；深链 301 重定向到统一页（T1/T2）───
  app.get('/account-insight.html', (req, res) => {
    const id = req.query.id;
    res.redirect(id ? `/account-360.html?id=${encodeURIComponent(id)}&tab=insight` : '/account-360.html');
  });
  app.get('/account-insight', (req, res) => res.redirect('/account-360.html'));
  app.get('/accounts/:id/insight', (req, res) =>
    res.redirect(`/account-360.html?id=${encodeURIComponent(req.params.id)}&tab=insight`));

  // ─── S05 待办工作台（已合并入 /my-todo.html，新入口 + 旧 URL 301 兼容）───
  app.get('/my-todo.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/my-todo.html', import.meta.url))));
  app.get('/my-todo', (req, res) => res.redirect('/my-todo.html'));
  app.get('/todo.html', (req, res) => res.redirect(301, '/my-todo.html'));
  app.get('/todo', (req, res) => res.redirect(301, '/my-todo.html'));

  // ─── S07 商机作战 静态页 + 别名（与 /deals/:id 字段核查互补）───
  app.get('/deal-detail.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/deal-detail.html', import.meta.url))));
  app.get('/deal-detail', (req, res) => res.redirect('/deal-detail.html'));
  // S04 schema 受控渲染页（与 /agents 手写监控台互补，路径独立）
  app.get('/agent-dashboard.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/agent-dashboard.html', import.meta.url))));
  app.get('/agent-dashboard', (req, res) => res.redirect('/agent-dashboard.html'));
  // ─── S08 报价详情 静态页 + 别名（navigation.to='/quotations/:id'）───
  app.get('/quotation-detail.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/quotation-detail.html', import.meta.url))));
  app.get('/quotation-detail', (req, res) => res.redirect('/quotation-detail.html'));
  app.get('/quotations/:id', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/quotation-detail.html', import.meta.url))));

  // ─── S09 合同详情 静态页 + 别名（navigation.to='/contracts/:id'）───
  app.get('/contract-detail.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/contract-detail.html', import.meta.url))));
  app.get('/contract-detail', (req, res) => res.redirect('/contract-detail.html'));
  app.get('/contracts/:id', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/contract-detail.html', import.meta.url))));

  // ─── S10 订单详情 静态页 + 别名（与 /orders/:id 字段核查互补）───
  app.get('/order-detail.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/order-detail.html', import.meta.url))));
  app.get('/order-detail', (req, res) => res.redirect('/order-detail.html'));
  app.get('/orders/:id', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/order-detail.html', import.meta.url))));

  // ─── S11 回款详情 静态页 + 别名（与 /payments/:id 字段核查互补）───
  app.get('/payment-detail.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/payment-detail.html', import.meta.url))));
  app.get('/payment-detail', (req, res) => res.redirect('/payment-detail.html'));
  app.get('/payments/:id', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/payment-detail.html', import.meta.url))));

  // ─── S12 发票详情 静态页 + 别名（与 /invoices/:id 字段核查互补）───
  app.get('/invoice-detail.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/invoice-detail.html', import.meta.url))));
  app.get('/invoice-detail', (req, res) => res.redirect('/invoice-detail.html'));
  app.get('/invoices/:id', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/invoice-detail.html', import.meta.url))));

  // ─── S21 方法论 SKILL 注册表 静态页 + 别名 + Render 子模块（第 16 项）───
  app.get('/skills.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/skills.html', import.meta.url))));
  app.get('/skills', (req, res) => res.redirect('/skills.html'));
  app.get('/portal/skillRegistryRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/skillRegistryRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // S21 受控壳板：统一壳 + fetch /api/page/skill-registry（受控渲染唯一出口；手写 skills.html 保留兼容）
  app.get('/skill-registry-board.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/skill-registry-board.html', import.meta.url))));
  app.get('/skill-registry-board', (req, res) => res.redirect('/skill-registry-board.html'));

  // S01 系统状态墙 受控壳：统一壳 + fetch /api/page/system-status（多源聚合：粒子计数/看板任务/审批待处理 + 最新粒子）
  app.get('/system-status.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/system-status.html', import.meta.url))));
  app.get('/system-status', (req, res) => res.redirect('/system-status.html'));

  // ─── 三系统概览页（监控仪表盘，只读；2026-09-10 新增，区别于配置页）───
  app.get('/system-overview/k.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/system-overview-k.html', import.meta.url))));
  app.get('/system-overview/k', (req, res) => res.redirect('/system-overview/k.html'));
  app.get('/system-overview/m.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/system-overview-m.html', import.meta.url))));
  app.get('/system-overview/m', (req, res) => res.redirect('/system-overview/m.html'));
  app.get('/system-overview/d.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/system-overview-d.html', import.meta.url))));
  app.get('/system-overview/d', (req, res) => res.redirect('/system-overview/d.html'));
  // 受控渲染端点（dynamic import，懒加载；renderers 在 src/http/render/systemOverview{K|M|D}.js）
  app.get('/api/page/system-overview-k', async (req, res) => {
    try {
      const me = resolveMe(req);
      // admin 可通过 ?scope=all 切换全租户视图（renderKnowledge 内 effective 判定）
      const scope = req.query?.scope || null;
      const { renderKnowledge } = await import('../http/render/systemOverviewK.js');
      res.json(await renderKnowledge({ me: { ...me, scope } }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/page/system-overview-m', async (req, res) => {
    try {
      const me = resolveMe(req);
      const { renderMemory } = await import('../http/render/systemOverviewM.js');
      res.json(await renderMemory({ me }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/page/system-overview-d', async (req, res) => {
    try {
      const me = resolveMe(req);
      const { renderDecision } = await import('../http/render/systemOverviewD.js');
      res.json(await renderDecision({ me }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 观测看板（静态）
  // 根路径 = AI 作战室（S02 主页，index.html）；营销/注册页见 /landing.html
  app.get('/', (req, res) => res.sendFile(fileURLToPath(new URL('../web/index.html', import.meta.url))));
  app.get('/landing.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/landing.html', import.meta.url))));
  app.get('/index.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/index.html', import.meta.url))));
  // 销售管道页（P2：DEAL 六阶段分列 + 内联详情区；导航「线索池/商机/L2C」落点）
  app.get('/pipeline.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/pipeline.html', import.meta.url))));
  app.get('/pipeline', (req, res) => res.redirect('/pipeline.html'));

  // 门户双页（v2）：Home.html = 登录+状态墙；index.html = AI 作战室
  app.get('/home.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/home.html', import.meta.url))));
  // S34 今日优先·高匹配商机明细（FIT 钻取目标）静态壳
  app.get('/today-priority.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/today-priority.html', import.meta.url))));
  app.get('/home', (req, res) => res.redirect('/home.html'));

  // 前端打分模块（ESM 单源：浏览器与 vitest 共用）
  app.get('/portal/scoring.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/scoring.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 共享导航已由 layout.js 取代（G6 收敛：nav.js 删除，路由随之下线）
  // ── UI 基建静态映射（2026-08-27 UI/导航/规范重构：统一设计系统 + 布局壳）──
  app.get('/portal/tokens.css', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/tokens.css', import.meta.url)), { headers: { 'Content-Type': 'text/css' } }));
  app.get('/portal/common.css', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/common.css', import.meta.url)), { headers: { 'Content-Type': 'text/css' } }));
  app.get('/portal/api.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/api.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/layout.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/layout.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // UI 架构级封死（2026-08-29）：Web Component 单一来源 + 格式化工具（计划批1 补充路由注册）
  app.get('/portal/components.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/components.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/drillModal.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/drillModal.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/util.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/util.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/layoutMenu.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/layoutMenu.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // 租户作用域条（admin/sysadmin 专属；named-accounts / pipeline / receivables 等列表页共用）
  app.get('/portal/tenantScopeBar.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/tenantScopeBar.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  // ── 配置中心 3 个 readable→ready 管理页（11 LLM / 15 七维 / 20 池）──
  app.get('/llm.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/llm.html', import.meta.url))));
  app.get('/llm', (req, res) => res.redirect('/llm.html'));
  // T4：多条 LLM 配置列表管理页（crm.llm_config；与旧单条 /llm.html 并存过渡）
  app.get('/llm-config.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/llm-config.html', import.meta.url))));
  app.get('/llm-config', (req, res) => res.redirect('/llm-config.html'));
  app.get('/portal/llmConfigRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/llmConfigRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/seven-dim.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/seven-dim.html', import.meta.url))));
  app.get('/seven-dim', (req, res) => res.redirect('/seven-dim.html'));
  app.get('/portal/sevenDimRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/sevenDimRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/pool-config.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/pool-config.html', import.meta.url))));
  app.get('/pool-config', (req, res) => res.redirect('/pool-config.html'));
  app.get('/portal/poolConfigRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/poolConfigRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));

  // ── 业务主数据门户（2026-08-28 实施计划）：门户总览 + 5 个维护面 ──
  // 架构纪律：页面 import 一律指向 portal/*Render.js 纯函数子模块（零服务端 import，浏览器 ESM 可加载）
  const BD_PAGES = [
    ['business-data', 'businessDataCenter'],
    ['product-catalog', 'productCatalogRender'],
    ['price-list', 'priceListRender'],
    ['offer-policy', 'offerPolicyRender'],
    ['dict-entries', 'dictEntriesRender'],
    ['payment-policy', 'paymentPolicyRender'],
  ];
  for (const [pg, mod] of BD_PAGES) {
    app.get(`/${pg}.html`, (req, res) => res.sendFile(fileURLToPath(new URL(`../web/${pg}.html`, import.meta.url))));
    app.get(`/portal/${mod}.js`, (req, res) =>
      res.sendFile(fileURLToPath(new URL(`../portal/${mod}.js`, import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  }
  app.get('/business-data', (req, res) => res.redirect('/business-data.html'));

  // ── 指名客户管理独立页（2026-08-30 实施计划 Task8：三区 = 名单总览/分配管理/告警提醒）──
  app.get('/named-account-manage.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/named-account-manage.html', import.meta.url))));
  app.get('/named-account-manage', (req, res) => res.redirect('/named-account-manage.html'));

  // 通用 Action 派发端点（设计 §4.3：crm-deal-swas-update 等写操作经此 HTTP 入口）
  // 经认证后派发任意已注册 Action；各 Action 自带 executor 五闸（决策/范围/RBAC/字段/审批），
  // 通道非 conversational → 写白名单闸跳过（认证 REST 调用，等价于连接器端点授权语义）。
  app.post('/api/action/:name', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const { name } = req.params;
      const body = req.body || {};
      const def = getAction(name);
      if (!def) return res.status(404).json({ error: `未知 Action: ${name}` });
      const r = await actionExecutor.dispatch(name, body, {
        actor: me.username || me.display_name || 'user',
        role: me.role,
        tenantId: me.tenantId || 'system',
        decision_id: body.decision_id || null,
      });
      if (!r.ok) return res.status(400).json({ ok: false, gate: r.gate, error: r.error });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 2026-09-03 C 方案 T3：P1 核心业务 action 语义化端点（agentSpec 已授权但 web 无专门入口）
  // 统一走 actionExecutor.dispatch（单一执行契约），复用通用端点 ctx 范式；路径参数并入 body。
  // crm-account-360 按 plan §2.2 B 收敛：web 聚合页保持直调 insightService，不补端点（保留 agent 视角轻量读）。
  // P1-1（2026-09-06）：原 `me.tenantId || 'system'` 兜底会让「登录态缺租户」静默获得 system 全权益，
  //   绕过套餐门禁 → 改为 null（缺失即可识别，由第 1.7 闸 fail-closed 拒绝）。
  const p1Ctx = (me, body) => ({
    actor: me.username || me.display_name || 'user', role: me.role,
    tenantId: me.tenantId ?? null, decision_id: body?.decision_id || null,
  });
  const p1Dispatch = async (req, res, name) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const body = req.body || {};
      const r = await actionExecutor.dispatch(name, body, p1Ctx(me, body));
      if (!r.ok) return res.status(400).json({ ok: false, gate: r.gate, error: r.error });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  };
  app.post('/api/crm/deal/:id/advance', (req, res) => p1Dispatch({ ...req, body: { id: req.params.id, ...req.body } }, res, 'crm-deal-advance'));
  app.post('/api/crm/deal/:id/reopen', (req, res) => p1Dispatch({ ...req, body: { id: req.params.id, ...req.body } }, res, 'crm-deal-reopen'));
  app.post('/api/crm/asset/attach', (req, res) => p1Dispatch(req, res, 'crm-asset-attach'));
  app.post('/api/crm/review-gate/:id/approve', (req, res) => p1Dispatch({ ...req, body: { id: req.params.id, ...req.body } }, res, 'crm-review-gate-approve'));
  app.post('/api/crm/memory', (req, res) => p1Dispatch(req, res, 'crm-memory-upsert'));

  // ─── P0-② 租户级 Knowledge 管理 API（docs/2026-09-03-tenant-knowledge-design.md §7）───
  // 写经 crm-knowledge-upsert（actionExecutor.dispatch 第0闸 + confirm 双段），此处只做只读清单与角色闸提交代理
  app.get('/api/knowledge', async (req, res) => {
    try {
      let me;
      try { me = await resolveMe(req); } catch { me = { ok: false }; }
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const kind = req.query.kind || null;
      const tid = scopeTenant(me); // admin/sysadmin 通配 '*'，普通用户自身租户
      const r = await query(
        `SELECT id, type, slug, title, state, payload, created_at FROM crm.particles
         WHERE type='CRM_KNOWLEDGE' AND ($1::text IS NULL OR payload->>'kind'=$1)
           AND ($2::text IS NULL OR tenant_id=$2 OR $2='*')
         ORDER BY (payload->>'confidence')::float DESC NULLS LAST, created_at DESC LIMIT 100`,
        [kind, tid]
      );
      res.json({ ok: true, rows: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 提交代理：角色闸（知识管理白名单，与 crm-knowledge-upsert rbac_roles 一致）+ 统一 dispatch
  app.post('/api/knowledge', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      if (!['manager', 'presales', 'exec', 'sysadmin'].includes(me.role)) {
        return res.status(403).json({ error: '角色无权录入知识' });
      }
      const r = await actionExecutor.dispatch('crm-knowledge-upsert', req.body || {}, {
        actor: me.username || me.display_name || 'user',
        role: me.role,
        tenantId: me.tenantId || 'system',
        decision_id: req.body?.decision_id || null,
      });
      if (!r.ok) return res.status(400).json({ ok: false, gate: r.gate, error: r.error });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 软停用（禁删铁律）：PATCH /api/particles/:id → data-particle-update，state 流转，绝无物理删除
  // 与 POST /api/particles 同范式：走 bootstrap + recordDecisionEvent('config_change') 落决策审计链
  app.patch('/api/particles/:id', async (req, res) => {
    const { state, patch, force } = req.body || {};
    // 业务主数据合法状态白名单（防任意 state 注入；各粒子 flow 的并集）
    const BD_STATES = ['draft', 'active', 'expired', 'discontinued', 'deprecated', 'registered', 'on_sale'];
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      if (state && !BD_STATES.includes(state)) {
        return res.status(400).json({ error: `非法 state: ${state}（须为 ${BD_STATES.join('/')}）` });
      }
      if (!state && (!patch || !Object.keys(patch).length)) {
        return res.status(400).json({ error: '无有效变更（state 或 patch 至少一项）' });
      }
      const ctx = { tenantId: scopeOf(me), actor: me.username || me.display_name || 'user', role: me.role, bootstrap: true };
      await recordDecisionEvent('config_change', {
        scenario_id: 'particle-state-transition',
        type: 'PATCH_PARTICLE_STATE', id: req.params.id, state: state || null,
        trigger_context: patch || {},
      }).catch(() => {});
      const r = await actionExecutor.dispatch('data-particle-update', { id: req.params.id, patch: patch || {}, state, force: force === true }, ctx);
      if (!r.ok) return res.status(400).json({ error: r.error, gate: r.gate });
      res.json({ particle: r.data, state: state || null });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // B6/B7 决策读模型路由挂载（自检卡 / 九尺子明细 / 八要素思维卡 / 场景 chip 真实聚合）
  registerDecisionReadRoutes(app);

  // 参数传播中枢路由挂载（继承矩阵 / 已落地留痕 / 推广候选 / 强制下发；全经决策第0闸）
  registerPropagationRoutes(app, pool);
}
