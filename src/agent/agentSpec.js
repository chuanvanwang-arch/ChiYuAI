// src/agent/agentSpec.js — 4 Agent 六段式（A接诊/B报价/C跟进/D评审 全自治）
// 设计输入：docs/specs/2026-08-29-agent-roster-4-agent-design.md §2（替换旧 3 个能力 agent）
export const agentSpecs = {
  'intake-router': {
    identity: { name: 'intake-router', derivedFrom: 'taskFlow:crm-intake-routing', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'data-particle-edge-create', 'crm-deal-advance', 'crm-account-360', 'method-intake-routing', 'method-dialog-router'],
      skillCalls: ['data-particle-read', 'method-intake-routing', 'method-dialog-router'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 3 },
    },
    context: { knowledgeLevel: 2, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['intake-router', 'followup-agent'], write: ['intake-router'] }, // lead-miner 已并入本体；下游 lead/account 上下文读 followup-agent
    evaluation: { metricTemplate: 'routing_accuracy', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
  'quote-engine': {
    identity: { name: 'quote-engine', derivedFrom: 'taskFlow:crm-quote-calculation', autonomy: 'recommend' },
    capabilities: {
      // method-stage-progression：阶段推进判定归报价 agent —— S3→S4 闸门 key 即 bantcc_quote（BANTCC+报价同源职责）
      actions: ['data-particle-read', 'data-particle-create', 'crm-deal-advance', 'crm-account-360', 'method-quote-engine', 'method-stage-progression'],
      skillCalls: ['data-particle-read', 'method-quote-engine', 'method-stage-progression'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 3 },
    },
    context: { knowledgeLevel: 3, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['quote-engine', 'followup-agent'], write: ['quote-engine'] }, // deal-coach 已废弃；管道上下文读 followup-agent
    evaluation: { metricTemplate: 'quote_accuracy', evaluator: 'stage2' },
    governance: { approvals: ['recommend'], concurrency: 3, profile: 'full' },
  },
  'followup-agent': {
    identity: { name: 'followup-agent', derivedFrom: 'taskFlow:crm-followup-reminder', autonomy: 'recommend' },
    capabilities: {
      // crm-asset-attach：非结构化证据挂接（2026-08-31 上传/挂接两步管道的第二步，业务写过闸）
      // method-funnel-classification（客户分类→拜访频度）+ method-behavior-standard（21 条拜访质检）
      //   归跟进 agent —— 与 followup_timeliness 职责同源（二者产出均为拜访节奏与质量）
      actions: ['data-particle-read', 'data-particle-create', 'data-particle-edge-create', 'crm-deal-advance', 'crm-deal-reopen', 'crm-account-360', 'crm-asset-attach', 'method-followup-engine', 'method-funnel-classification', 'method-behavior-standard', 'crm-followup-requirement-collect'],
      skillCalls: ['data-particle-read', 'data-particle-create', 'crm-asset-attach', 'method-followup-engine', 'method-funnel-classification', 'method-behavior-standard', 'crm-followup-requirement-collect'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 3 },
    },
    context: { knowledgeLevel: 3, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['followup-agent', 'quote-engine'], write: ['followup-agent'] }, // deal-coach 已废弃
    evaluation: { metricTemplate: 'followup_timeliness', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
  'review-gate': {
    identity: { name: 'review-gate', derivedFrom: 'taskFlow:crm-review-gate', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'data-particle-edge-create', 'crm-deal-advance', 'crm-account-360', 'method-review-gate', 'crm-review-gate-approve'],
      skillCalls: ['data-particle-read', 'method-review-gate'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 4 },
      kgTarget: 'L3', // KG 就绪后升级到 L3 上下文（当前 KG 降级，见 agents.js l3DegradedGuard 守护）
    },
    context: { knowledgeLevel: 3, coverage: '>=80%', coldStart: 'adaptive' },
    // 评审读报价+路由上下文；decision-retro 为设计 §13 T21 契约要求（评审需回溯本场景历史复盘结论，
    // 与 T21「分级授权对象化」的 decision_id 溯源同轴）。缺此项 → validate-contract 报 memory 不在 read 内。
    memory: { read: ['review-gate', 'quote-engine', 'intake-router', 'decision-retro'], write: ['review-gate'] }, // crm-copilot/deal-coach 已废弃
    evaluation: { metricTemplate: 'review_precision', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
  'decision-retro': {
    identity: { name: 'decision-retro', derivedFrom: 'taskFlow:crm-decision-retrospective', autonomy: 'recommend' },
    capabilities: {
      // 权限闭包：skillCalls ⊆ actions（缺一项即整册校验失败——agent 不得调用未授权 action）
      actions: ['data-particle-read', 'decision-retrospective'],
      skillCalls: ['decision-retrospective', 'data-particle-read'],
      // KG 降级契约（l3DegradedGuard）：阶段 1 无 KG，运行时层只能到 L2；
      // L3 意图改由 kgTarget 表达（KG 就绪后升级，与 review-gate 同范式），
      // layers 直接写 L3 会同时触发 l3_stated_but_kg_degraded 与 kg_target_convergence 两道闸门。
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 5 },
      kgTarget: 'L3',
    },
    context: { knowledgeLevel: 3, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['decision-retro', 'review-gate'], write: ['decision-retro'] },
    evaluation: { metricTemplate: 'retro_patch_quality', evaluator: 'stage2' },
    governance: { approvals: ['recommend'], concurrency: 1, profile: 'full' },
  },
  'decision-agent': {
    identity: { name: 'decision-agent', derivedFrom: 'taskFlow:crm-decision-wiring', autonomy: 'autonomous' },
    capabilities: {
      actions: ['data-particle-read', 'data-particle-create', 'crm-memory-upsert', 'decision-retrospective', 'method-decision-enrich', 'method-decision-execute', 'discovery-run', 'discovery-enrich', 'discovery-research'],
      skillCalls: ['method-decision-enrich', 'method-decision-execute', 'data-particle-read', 'data-particle-create', 'discovery-run', 'discovery-enrich', 'discovery-research'],
      // KG 降级契约（l3DegradedGuard）：与 decision-retro 同范式——阶段 1 无 KG，运行时层只能到 L2；
      // L3/L4 意图改由 kgTarget 表达。直接写 L3 会触发 l3_stated_but_kg_degraded 闸门
      // （2026-09-03 全量回归实测：decision-agent 曾写 L1-L4，导致 agentSpec/g3-knowledge-scope/g3-guardian 三处断言失败）。
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 5 },
      kgTarget: 'L3',
    },
    context: { knowledgeLevel: 4, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['decision-agent', 'review-gate'], write: ['decision-agent'] },
    evaluation: { metricTemplate: 'decision_wiring_quality', evaluator: 'stage2' },
    governance: { approvals: ['recommend'], concurrency: 2, profile: 'full' },
  },
  'prospecting': {
    identity: { name: 'prospecting', derivedFrom: 'taskFlow:crm-prospecting', autonomy: 'recommend' },
    capabilities: {
      // 三处同改（装配闭包）：本 agent 的 skillCalls ⊆ actions；prospecting-* Action 在 T5 注册
      // actions 含 crm-account-360（对齐设计 §A.3：拓客候选入池前可对既有账户做画像核对）
      // method-outreach-hook（2026-09-15 P1-1）：触达钩子方法论归 prospecting —— 获客链路"线索→钩子"同源职责
      actions: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm', 'prospecting-lookup', 'crm-account-360', 'method-outreach-hook'],
      skillCalls: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm', 'prospecting-lookup', 'method-outreach-hook'],
      knowledgeScope: { layers: ['L1'], maxHops: 2 },
    },
    context: { knowledgeLevel: 1, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['intake-router'], write: [] },
    evaluation: { metricTemplate: 'prospecting_quality', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
  // 经销商渠道门户：厂商侧 channel_manager 角色承载的渠道经理 agent
  // 设计输入：docs/2026-09-18-dealer-portal-design.md（v2 §4）
  // 职责：经销商准入编排、跨 N 经销商撞单/窜货冲突检测与仲裁、返利结算、政策下发。
  // 闭环铁律：skillCalls ⊆ actions（仅用真实已注册原语）；跨租户只读经 federationReadScope，写经 federation 模块+第0闸。
  'channel-agent': {
    identity: { name: 'channel-agent', derivedFrom: 'taskFlow:crm-channel-management', autonomy: 'recommend' },
    capabilities: {
      // 真实已注册原语；经销商专属写逻辑复用 data-particle-create（写 dealer_conflict_log 等厂商租户粒子），
      // 经 federation 模块（src/federation/*）+ dealerRoutes 服务端实现，不新增 Action Registry 条目。
      actions: ['data-particle-read', 'data-particle-create'],
      skillCalls: ['data-particle-read', 'data-particle-create'],
      knowledgeScope: { layers: ['L1', 'L2'], maxHops: 4 },
    },
    context: { knowledgeLevel: 3, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['channel-agent'], write: ['channel-agent'] },
    evaluation: { metricTemplate: 'channel_conflict_precision', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 2, profile: 'full' },
  },
};