// src/skills/seed.js — 种子 SKILL（阶段 1：crm-deal-analyze + crm-skill-fallback + 7 个方法论）
// 设计输入：03 编排设计（SKILL 驱动；rule 步骤零 LLM / 推理步骤决策）
//            §6.6 方法论以 SKILL 存放（SKILL 为唯一事实源，skill_registry 后台可停用）
import { registerSkill } from './registry.js';

export function seedSkills() {
  registerSkill({
    slug: 'crm-deal-analyze', version: 1,
    steps: [
      { step: 1, action: 'data-particle-read', decision: 'rule',
        params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: ['result.length>0'] },
      { step: 2, action: null, decision: 'j_judge',
        prompt: '基于商机阶段/跟进/赢率给出推进建议 {{steps[0].result}}',
        preconditions: ['steps[0].done'], postconditions: ['decision.finalized'] },
    ],
  });
  registerSkill({
    slug: 'crm-skill-fallback', version: 1,
    steps: [
      { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [] },
    ],
  });

  // 7 个方法论 SKILL（方法即服务 §6.6：SKILL 为唯一事实源；skills/method-* 目录承载完整知识）
  // registry 声明仅登记元数据 + rbac_roles + enabled；目录内容（SKILL.md/methodology.json/...）由外部智能体经 MCP 获取
  const METHOD_SKILLS = [
    {
      slug: 'method-bant', version: 1,
      description: 'BANT 预算-权限-需求-时间线销售资质方法论——四维逐项评估商机资质，门控商机是否值得推进',
      rbac_roles: ['sales'],
    },
    {
      slug: 'method-meddicc', version: 1,
      description: 'MEDDICC 复杂商机赢单方法论——七维校验（指标/经济买家/决策标准/决策流程/识破痛苦/冠军/竞争）',
      rbac_roles: ['sales', 'manager'],
    },
    {
      slug: 'method-opportunity-matrix', version: 1,
      description: '机会矩阵方法论（商业价值×可行性×竞争定位）——商机组合优先级排序',
      rbac_roles: ['sales', 'manager'],
    },
    {
      slug: 'method-role-map', version: 1,
      description: '客户角色地图方法论——识别决策链/影响者/使用者/利益相关方四类角色并标注立场',
      rbac_roles: ['presales', 'sales'],
    },
    {
      slug: 'method-risk-tradeoff', version: 1,
      description: '风险权衡方法论（风险×收益/红线/缓解）——量化商机风险收益比，触碰红线一票否决',
      rbac_roles: ['sales', 'manager'],
    },
    {
      slug: 'method-stop-loss', version: 1,
      description: '止损点方法论（负净值/投入预算/退出门）——预设止损阈值并触发退出门，防止沉没成本绑架',
      rbac_roles: ['exec', 'manager'],
    },
    {
      slug: 'method-fact-vs-script', version: 1,
      description: '事实vs话术方法论——区分客户沟通中的事实（可验证证据）与话术（口头表述），事实优先',
      rbac_roles: ['sales', 'presales'],
    },
    {
      slug: 'method-presales', version: 1,
      description: '售前解决方案设计方法论——方案契合/技术可行/价值量化/风险异议/差异化/交付可信六维评估，门控商机推进报价',
      rbac_roles: ['presales'],
    },
    {
      slug: 'method-intake-routing', version: 1,
      description: '接诊分流方法论（意图识别×商机分级×派发路由）——新询盘接入识别意图与商机级别，按级派发 B/C/D',
      rbac_roles: ['sales', 'manager'],
    },
    {
      slug: 'method-quote-engine', version: 1,
      description: '报价测算方法论（配置×成本×毛利实时测算）——输出 A/B 两方案含毛利预估，报价有数据支撑',
      rbac_roles: ['sales', 'presales'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-quote-estimate', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于报价测算 {{steps[1].result}} 复核 A/B 两方案毛利与风险，给出推荐方案与报价建议',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
    {
      slug: 'method-followup-engine', version: 1,
      description: '跟进催办方法论（自动跟进×节点催办×超时转人工）——自动跟进提醒、节点催办、超期未跟进预警转人工',
      rbac_roles: ['sales'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-followup-schedule', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于跟进计划 {{steps[1].result}} 标记超时商机并给出催办/转人工建议',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
    {
      slug: 'method-review-gate', version: 1,
      description: '评审把关方法论（双闸门×专家介入×内置四维审查）——重大商机报价复核与合同确认，决策留痕可溯源',
      rbac_roles: ['manager', 'exec'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-review-gate-evaluate', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于四维审查 {{steps[1].result}} 给出评审结论（pass/conditional/fail）与整改建议',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
    {
      slug: 'method-decision-enrich', version: 1,
      description: '决策前上下文富集——并行装配 L1-L4 记忆/知识，补充先例与图谱线索，供决策审计轨迹（不阻塞决策判定）',
      rbac_roles: ['sales', 'manager'],
      // 决策前富集为只读：① 无 decision_id 不可写（第0闸：无决策不写）；② 富集本质是"读取+推理"，
      //   记忆写回归属决策后 decision-execute（携带 decision_id 落库，合规闭环）。
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: null, decision: 'j_judge',
          prompt: '基于装配上下文 {{steps[0].result}} 归纳本次决策可用的记忆/知识线索与风险注解',
          preconditions: ['steps[0].done'], postconditions: ['decision.finalized'] },
      ],
    },
    {
      slug: 'method-decision-execute', version: 1,
      description: '决策后治理写回——记忆沉淀（crm-memory-upsert write-through 已闭环）+ 决策复盘。注：决策网络挂接(decision_relation) 为后续 Task，需先例发现通道（enrich 产出）回填 to_id，当前 j_judge 仅建议关联、不真写权威表',
      rbac_roles: ['sales', 'manager'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-memory-upsert', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: 'decision-retrospective', decision: 'rule', params: {}, preconditions: ['steps[1].done'], postconditions: ['result.ok'] },
        { step: 4, action: null, decision: 'j_judge',
          prompt: '基于决策结果 {{steps[2].result}} 生成可复核整改/沉淀结论并建议决策关系(decision_relation)/粒子图关联',
          preconditions: ['steps[2].done'], postconditions: ['decision.finalized'] },
      ],
    },
    // —— CRM 三大业务方法（2026-09-02 补 steps[]，由「仅元数据」升级为真执行）——
    // 落点 action 见 seed-actions.js（crm-stage-progression-evaluate / crm-funnel-classify / crm-behavior-check），
    // 判定内核复用 src/sales/* 既有纯函数（stageTaxonomy / funnelQuality / behaviorChecklist），不在此重写业务规则。
    {
      slug: 'method-stage-progression', version: 1,
      description: '商机阶段推进方法论（S1-S6 大漏斗阶段×客户行为判定×推进前置闸）——判断商机真实阶段与能否推进',
      rbac_roles: ['sales', 'manager'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-stage-progression-evaluate', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于阶段判定 {{steps[1].result}} 说明当前所处阶段、能否推进至下一阶段，以及缺失闸门证据的补齐建议',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
    {
      slug: 'method-funnel-classification', version: 1,
      description: '大漏斗客户分类方法论（商机/目标/潜力四象限×接触节奏）——判断客户类别与拜访频度',
      rbac_roles: ['sales', 'manager'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-funnel-classify', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于漏斗分类 {{steps[1].result}} 说明各商机所属分区与加权金额，给出拜访频度与推进优先级建议',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
    {
      slug: 'method-behavior-standard', version: 1,
      description: '销售行为合格线方法论（21 条 BH-01~07 有/无检查项×TAORAN 六要素拜访记录）——拜访质检与行为合格判定',
      rbac_roles: ['sales', 'manager'],
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_ACCOUNT' }, preconditions: [], postconditions: [] },
        { step: 2, action: 'crm-behavior-check', decision: 'rule', params: {}, preconditions: ['steps[0].done'], postconditions: ['result.ok'] },
        { step: 3, action: null, decision: 'j_judge',
          prompt: '基于 21 条行为合格线判定 {{steps[1].result}} 说明达标情况与缺口清单，给出拜访质量改进建议',
          preconditions: ['steps[1].done'], postconditions: ['decision.finalized'] },
      ],
    },
  ];
  for (const skill of METHOD_SKILLS) {
    registerSkill(skill);
  }

  // 4 个 CRM 智能体 SKILL（§6.13 对话式 CRM 智能体包：编排/查询/写入/风险）
  // registry 仅登记元数据；skills/crm-{native,query,write,risk}/ 目录承载完整 SKILL
  const AGENT_SKILLS = [
    {
      slug: 'crm-native', version: 1,
      description: 'CRM 智能体包编排入口——意图路由→技能分发（query/write/risk + method-*），惰性编排，角色自适应',
      rbac_roles: ['sales', 'manager', 'presales', 'exec', 'finance'],
      sub_skills: ['crm-query', 'crm-write', 'crm-risk', 'method-bant', 'method-meddicc', 'method-opportunity-matrix', 'method-role-map', 'method-risk-tradeoff', 'method-stop-loss', 'method-fact-vs-script', 'method-stage-progression', 'method-funnel-classification', 'method-behavior-standard'],
    },
    {
      slug: 'crm-query', version: 1,
      description: 'CRM 跨模块推理查询技能——粒子图/AGE多跳/pgvector语义/决策网络先例检索，一句话返回结构化结果（只读直连）',
      rbac_roles: ['sales', 'manager', 'presales', 'exec', 'finance'],
      read_only: true,
    },
    {
      slug: 'crm-write', version: 1,
      description: 'CRM 对话式写入技能——两阶段写入（取表单→确认→执行→验证）+ 决策第0闸（无 decision_id 不写）+ action-confirm（HITL）',
      rbac_roles: ['sales', 'manager', 'presales', 'exec', 'finance'],
      write_two_phase: true,
      require_decision_id: true,
    },
    {
      slug: 'crm-risk', version: 1,
      description: 'CRM 链断裂/异常检测技能——商机→技术方案>30天 / 赢单前无方案 / 回款逾期，常驻探测+SSE 主动预警（先于提问）',
      rbac_roles: ['sales', 'manager', 'presales', 'exec', 'finance'],
      read_only: true,
      proactive_scan: true,
    },
  ];
  for (const skill of AGENT_SKILLS) {
    registerSkill(skill);
  }

  // 智能体执行体 SKILL（D1/D3 修复 2026-09-01）：
  //   agentSpec.skillCalls 声明的是 SKILL slug，而此前 SKILL 注册表只登记了 method-* / crm-*，
  //   导致 ① decision-retrospective 无 SKILL 可装载、② data-particle-read 只是 action 不是 SKILL，
  //   命名空间混淆，真接线后 agentLoop.getSkill() 直接抛「SKILL 不存在」。
  //   此处补齐两个执行体 SKILL，使 skillCalls 与注册表形成真闭包。
  const EXEC_SKILLS = [
    {
      slug: 'data-particle-read', version: 1,
      description: '粒子读取 SKILL（单步 rule 包装）——各 agent 的基础只读步骤，按 type/query 取粒子',
      rbac_roles: ['sales', 'manager', 'presales', 'exec', 'finance'],
      read_only: true,
      steps: [
        { step: 1, action: 'data-particle-read', decision: 'rule', params: {}, preconditions: [] },
      ],
    },
    {
      slug: 'decision-retrospective', version: 1,
      description: '决策复盘 SKILL（根因分布 × 整改处方）——汇总窗口内决策质量，产出可复核整改处方建议',
      rbac_roles: ['sales', 'manager', 'exec'],
      steps: [
        { step: 1, action: 'decision-retrospective', decision: 'rule',
          params: { windowDays: 30, limit: 20 }, preconditions: [], postconditions: ['result.ok'] },
        { step: 2, action: null, decision: 'j_judge',
          prompt: '基于决策复盘汇总 {{steps[0].result}} 给出：① 主要根因分布 ② 应连边缺失情况 ③ 可执行的整改处方建议（按优先级排序）',
          preconditions: ['steps[0].done'], postconditions: ['decision.finalized'] },
      ],
    },
  ];
  for (const skill of EXEC_SKILLS) {
    registerSkill(skill);
  }
}
