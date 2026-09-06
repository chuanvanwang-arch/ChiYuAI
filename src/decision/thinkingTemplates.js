// P0-② 思维要素拆解（Real-traffic verification · 场景实例化）
// 设计依据：docs/2026-09-02-cognitive-decision-unified-design.md §1.1（八要素）/§5（八要素×供给×目标字段）/§7.2（S1 聚焦矩阵）
//
// 职责：把"线索是否升级为机会"这类具体业务决策，拆解到 8 个思维要素（八要素物化列），
//       每个要素给出：要回答的核心问题、写前骨架引导(prompts)、目标字段、七维供给源、
//       绑定方法论概念、九尺子评分键、该场景的具体范例。
//
// 这是 Pre 阶段（§8）生成"思考骨架草稿"的单一事实源：调用方（决策表单 / Agent 起意）打开
// 决策表单时，buildPreContext 据此产出 8 要素填空骨架，销售/ Agent 只需确认或修改，
// 不必从零组织思维 —— 直接喂给 createDecision 的八要素入参，再经 scoreDecision/selfcheck/story 闭环。
//
// 命名铁律（附录 B）：八要素顺序 = intent/assumptions/inference/viewpoints/implications/risk_register/stop_loss/concept_refs
//                   （与 materializeEightElements、decisionRepo INSERT 列序一致）；禁用「关联性」用「相关性」。
//
// 与 DB 的边界：focus_elements/focus_rulers/required_dims 已落 decision_scenario（B4 回填），
//   本模块是"方法论层提问分解"，与场景配置正交、可独立版本化与单测，不进 schema。

/**
 * 单个场景的思维要素拆解。
 * @typedef {Object} ElementDecomp
 * @property {string} element     八要素列名（intent/assumptions/inference/viewpoints/implications/risk_register/stop_loss/concept_refs）
 * @property {string} label       中文要素名
 * @property {string} guiding_question 该要素要回答的核心问题
 * @property {string[]} prompts   写前骨架引导（填空提示）
 * @property {string[]} expected_fields 目标字段（对应八要素 JSONB 内部结构）
 * @property {string[]} source_dims 七维事实域供给源（identity/structure/semantics/time_config/operational_state/governance/decision_history）
 * @property {string[]} methodology 绑定的方法论概念（BANT/MEDDICC/OPP_MATRIX/ROLE_MAP/RISK_TRADEOFF/STOP_LOSS）
 * @property {string[]} ruler_keys 九尺子评分该要素的尺子键（clarity/accuracy/precision/relevance/depth/breadth/logic/importance/fairness）
 * @property {string} example     该场景的具体范例
 */

/**
 * 各场景的思维要素拆解注册表（单一事实源）。
 * 当前覆盖 P0-② 验证场景 LEAD_FOLLOW_UP（线索是否升级为机会 = S1 线索发掘的升级判定）。
 * 其它场景按需补：每个新增场景 = 一个 key + 8 要素数组（缺要素 = 该场景不聚焦，留空数组即可）。
 */
const TEMPLATES = {
  LEAD_FOLLOW_UP: {
    scenario_id: 'LEAD_FOLLOW_UP',
    stage_label: '一、线索',
    scenario_note: '决策："这条线索（如工博会留资/电话咨询）是否应升级为正式商机（进入 S2 机会评估）？"',
    // 八要素拆解（顺序与 materializeEightElements 列序一致）
    elements: [
      {
        element: 'intent',
        label: '目的与核心问题',
        guiding_question: '为什么要把这条线索升级为商机？这次决策要回答的核心问题是什么？',
        prompts: [
          '升级的商业目的（例：客户在工博会明确表达今年上产线的预算意向）',
          '要回答的核心问题（例：该线索是否达到 BANT 资格、是否值得投入售前资源）',
          '子问题清单（例：预算是否确认？决策人是谁？时间窗？）',
        ],
        expected_fields: ['purpose', 'question', 'sub_questions'],
        source_dims: ['identity', 'structure'],
        methodology: ['BANT', 'OPP_MATRIX'],
        ruler_keys: ['clarity'],
        example: '目的：判断是否将"XX制造"工博会线索升级为商机；问题：该客户是否具备真实预算与决策窗口',
      },
      {
        element: 'assumptions',
        label: '假设台账',
        guiding_question: '我们基于哪些假设判断它值得升级？每条假设的根据(basis)是什么？什么证据能推翻它？',
        prompts: [
          '假设清单：每条 {text, basis, falsifiable_by, evidence_ref[]}',
          '例：text="客户今年确有产线预算" basis="工博会面谈+两次电话" falsifiable_by="预算被否"',
        ],
        expected_fields: ['id', 'text', 'basis', 'falsifiable_by', 'evidence_ref', 'risk_if_wrong'],
        source_dims: ['decision_history'],
        methodology: ['BANT', 'MEDDICC'],
        ruler_keys: ['accuracy', 'fairness'],
        example: '假设"决策人为生产总监李工" basis="客户介绍" falsifiable_by="实际决策人为采购总监"',
      },
      {
        element: 'inference',
        label: '推理链',
        guiding_question: '从线索信号到"值得升级"的推理链是什么？每一步是否同时有证据和所依赖的假设？',
        prompts: [
          'chain: [{evidence, via_assumption, conclusion}]',
          'conclusion: 最终结论',
          '例：evidence="两次电话+工博会留资" via_assumption="有真实需求" → conclusion="应升级为商机"',
        ],
        expected_fields: ['chain', 'conclusion'],
        source_dims: ['semantics'],
        methodology: ['OPP_MATRIX'],
        ruler_keys: ['depth', 'logic'],
        example: '证据"客户主动询问报价区间" 经假设"进入比价阶段" → 结论"线索已升温"',
      },
      {
        element: 'viewpoints',
        label: '视角覆盖',
        guiding_question: '谁会同意/反对升级？我们漏掉了谁的视角？',
        prompts: [
          'viewpoints: [{stance, holder, covered}]',
          '必须含反方（例：stance="预算未确认，不应现在升级"）',
        ],
        expected_fields: ['stance', 'holder', 'covered'],
        source_dims: ['structure', 'semantics'],
        methodology: ['ROLE_MAP'],
        ruler_keys: ['breadth', 'fairness'],
        example: '销售"升级抢窗口" / 售前"资源紧张" / 反方"预算未确认"',
      },
      {
        element: 'implications',
        label: '意涵与连锁后果',
        guiding_question: '升级后会带来什么连锁后果？正面与负面分别是什么？概率与缓解？',
        prompts: [
          'implications: [{type:positive|negative, text, probability, mitigation}]',
          '例：negative"占用售前 2 周，若判断错则空耗" probability=0.3 mitigation="设 2 周止损"',
        ],
        expected_fields: ['type', 'text', 'probability', 'mitigation'],
        source_dims: ['operational_state', 'time_config'],
        methodology: ['OPP_MATRIX', 'RISK_TRADEOFF'],
        ruler_keys: ['relevance', 'logic'],
        example: '正面"进入 S2 机会评估" / 负面"若线索为假，浪费商机管道容量"',
      },
      {
        element: 'risk_register',
        label: '风险清单',
        guiding_question: '升级判断错误有哪些风险？严重度、证据、缓解、责任人？',
        prompts: [
          'risk_register: [{risk, severity, evidence, mitigation, owner}]',
          '例：risk="线索为假商机" severity="high" evidence="无预算佐证" mitigation="先验证预算再投入" owner="销售"',
        ],
        expected_fields: ['risk', 'severity', 'evidence', 'mitigation', 'owner'],
        source_dims: ['operational_state'],
        methodology: ['RISK_TRADEOFF'],
        ruler_keys: ['relevance'],
        example: '风险"竞品已介入" severity="medium" mitigation="一周内差异化价值沟通"',
      },
      {
        element: 'stop_loss',
        label: '止损条件',
        guiding_question: '什么条件触发我们要撤销/冻结这次升级？截止日与触发？',
        prompts: [
          'stop_loss: {condition, deadline, trigger, owner, status:"armed"|"triggered"|"released"}',
          '例：condition="2 周内无法约到决策人面谈" deadline="+14d" status="armed"',
        ],
        expected_fields: ['condition', 'deadline', 'trigger', 'owner', 'status'],
        source_dims: ['time_config'],
        methodology: ['STOP_LOSS'],
        ruler_keys: ['relevance'],
        example: '止损"若 14 天内未拿到预算确认函，则回退为线索"',
      },
      {
        element: 'concept_refs',
        label: '方法论概念引用',
        guiding_question: '本次升级判定依据了哪些方法论概念（BANT/MEDDICC 等）？哪些维度是必填且已命中？',
        prompts: [
          'concept_refs: [{methodology_id, dimension_key, weight, required, hit}]',
          '例：{methodology_id:"BANT", dimension_key:"budget", required:true, hit:true}',
        ],
        expected_fields: ['methodology_id', 'dimension_key', 'weight', 'required', 'hit'],
        source_dims: [],
        methodology: ['BANT', 'MEDDICC', 'OPP_MATRIX'],
        ruler_keys: ['importance'],
        example: 'BANT.budget=hit, BANT.authority=hit, BANT.need=hit, BANT.timeline=pending',
      },
    ],
  },
  OPP_QUALIFY: {
    scenario_id: 'OPP_QUALIFY',
    stage_label: '二、机会评估',
    scenario_note: '决策："这条商机是真机会 / 伪需求 / 陪标 / 是否追加售前资源？"',
    elements: [
      { element: 'intent', label: '目的与核心问题', guiding_question: '为什么要把这条线索认定为正式商机？本次决策要回答的核心问题是什么？', prompts: ['认定商业目的（例：客户进入比价，需投入方案与报价资源）', '核心问题：是否具备 MEDDICC 六要素真实信号', '子问题：痛点来源/预算获批/决策链完整度'], expected_fields: ['purpose','question','sub_questions'], source_dims: ['identity','structure'], methodology: ['MEDDICC','OPP_MATRIX'], ruler_keys: ['clarity'], example: '目的：判断"XX制造产线项目"为真机会；问题：Metrics/Economic Buyer/Pain 是否齐备' },
      { element: 'assumptions', label: '假设台账', guiding_question: '我们基于哪些假设认定它是真机会？每条假设的根据与可推翻条件？', prompts: ['假设清单 {text,basis,falsifiable_by,evidence_ref[]}', '例：text="客户预算已批" basis="对方透露立项" falsifiable_by="未见批文"'], expected_fields: ['id','text','basis','falsifiable_by','evidence_ref','risk_if_wrong'], source_dims: ['decision_history'], methodology: ['MEDDICC'], ruler_keys: ['accuracy','fairness'], example: '假设"决策链含生产总监+采购总监" basis="对方介绍" falsifiable_by="实际仅采购拍板"' },
      { element: 'inference', label: '推理链', guiding_question: '从线索信号到"真机会"的推理链？每步证据与所依赖假设？', prompts: ['chain:[{evidence,via_assumption,conclusion}]', 'conclusion: 最终结论'], expected_fields: ['chain','conclusion'], source_dims: ['semantics'], methodology: ['OPP_MATRIX'], ruler_keys: ['depth','logic'], example: '证据"客户主动安排方案讲解" 经假设"进入短名单" → 结论"真机会"' },
      { element: 'viewpoints', label: '视角覆盖', guiding_question: '谁支持/反对认定真机会？决策链各角色立场？漏了谁？', prompts: ['viewpoints:[{stance,holder,covered}]', '必须含反方（例：stance="竞品已绑定，不应重注"）'], expected_fields: ['stance','holder','covered'], source_dims: ['structure','semantics'], methodology: ['ROLE_MAP'], ruler_keys: ['breadth','fairness'], example: '支持"售前看痛点明确" / 反对"商务看预算未批"' },
      { element: 'implications', label: '意涵与连锁后果', guiding_question: '认定真机会后连锁后果？正负面与概率缓解？', prompts: ['implications:[{type,text,probability,mitigation}]', '例：negative"投入方案资源若错则空耗" probability=0.3 mitigation="设阶段门"'], expected_fields: ['type','text','probability','mitigation'], source_dims: ['operational_state','time_config'], methodology: ['OPP_MATRIX','RISK_TRADEOFF'], ruler_keys: ['relevance','logic'], example: '正面"进入 S3 方案价值" / 负面"若伪需求浪费商机管道"' },
      { element: 'risk_register', label: '风险清单', guiding_question: '认定错误有哪些风险？严重度/证据/缓解/责任人？', prompts: ['risk_register:[{risk,severity,evidence,mitigation,owner}]', '例：risk="陪标" severity="high" evidence="仅要报价不参与设计" mitigation="验证决策参与度"'], expected_fields: ['risk','severity','evidence','mitigation','owner'], source_dims: ['operational_state'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance'], example: '风险"竞品已内定" severity="medium" mitigation="试探真实决策标准"' },
      { element: 'stop_loss', label: '止损条件', guiding_question: '什么条件触发撤销/冻结"真机会"认定？截止与触发？', prompts: ['stop_loss:{condition,deadline,trigger,owner,status}', '例：condition="30天无决策链进展" deadline="+30d" status="armed"'], expected_fields: ['condition','deadline','trigger','owner','status'], source_dims: ['time_config'], methodology: ['STOP_LOSS'], ruler_keys: ['relevance'], example: '止损"若 30 天内决策链仍缺生产总监，则回退为培育"' },
      { element: 'concept_refs', label: '方法论概念引用', guiding_question: '本次认定依据了哪些方法论概念（MEDDICC/OPP_MATRIX/ROLE_MAP）？必填且命中？', prompts: ['concept_refs:[{methodology_id,dimension_key,weight,required,hit}]', '例：{methodology_id:"MEDDICC",dimension_key:"economic_buyer",required:true,hit:false}'], expected_fields: ['methodology_id','dimension_key','weight','required','hit'], source_dims: [], methodology: ['MEDDICC','OPP_MATRIX','ROLE_MAP'], ruler_keys: ['importance'], example: 'MEDDICC.metrics=hit, MEDDICC.economic_buyer=pending, ROLE_MAP.decision_chain=pending' },
    ],
  },
  CLIENT_STRATEGY: {
    scenario_id: 'CLIENT_STRATEGY',
    stage_label: '三、客户策略',
    scenario_note: '决策："主攻角色是谁？对支持者/中立者/反对者分别采取什么策略？"',
    elements: [
      { element: 'intent', label: '目的与核心问题', guiding_question: '本次客户策略要达成的核心目的？回答什么？', prompts: ['策略目的（例：锁定经济买手+教练，孤立反对者）', '核心问题：关键人图谱是否完整', '子问题：支持/中立/反对立场'], expected_fields: ['purpose','question','sub_questions'], source_dims: ['identity','structure'], methodology: ['ROLE_MAP','MEDDICC'], ruler_keys: ['clarity'], example: '目的：让生产总监成为教练；问题：是否识别全部决策影响者' },
      { element: 'assumptions', label: '假设台账', guiding_question: '关于各角色立场的假设？根据与可推翻条件？', prompts: ['假设 {text,basis,falsifiable_by}', '例：text="采购是支持者" basis="其推动流程" falsifiable_by="其压价态度"'], expected_fields: ['id','text','basis','falsifiable_by','evidence_ref','risk_if_wrong'], source_dims: ['decision_history'], methodology: ['ROLE_MAP'], ruler_keys: ['accuracy','fairness'], example: '假设"IT 是中立" basis="未表态" falsifiable_by="其安全合规门槛"' },
      { element: 'inference', label: '推理链', guiding_question: '从接触信号到"角色立场"的推理？证据与假设？', prompts: ['chain:[{evidence,via_assumption,conclusion}]'], expected_fields: ['chain','conclusion'], source_dims: ['semantics'], methodology: ['FACT_VS_TALK'], ruler_keys: ['depth','logic'], example: '证据"对方只谈价格不谈标准" 经假设"采购主导" → 结论"采购为决策核心"' },
      { element: 'viewpoints', label: '视角覆盖', guiding_question: '支持者/中立者/反对者视角是否都覆盖？', prompts: ['viewpoints:[{stance,holder,covered}]', '反对者立场必须显式（FACT_VS_TALK）'], expected_fields: ['stance','holder','covered'], source_dims: ['structure','semantics'], methodology: ['ROLE_MAP','FACT_VS_TALK'], ruler_keys: ['breadth','fairness'], example: '支持"生产总监要效率" / 反对"财务要低价" / 中立"IT 要合规"' },
      { element: 'implications', label: '意涵与连锁后果', guiding_question: '策略误判的连锁后果？正负面？', prompts: ['implications:[{type,text,probability,mitigation}]'], expected_fields: ['type','text','probability','mitigation'], source_dims: ['operational_state','time_config'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance','logic'], example: '负面"误判反对者导致方案被毙" probability=0.25 mitigation="双面验证"' },
      { element: 'risk_register', label: '风险清单', guiding_question: '策略执行风险？严重度/证据/缓解？', prompts: ['risk_register:[{risk,severity,evidence,mitigation,owner}]'], expected_fields: ['risk','severity','evidence','mitigation','owner'], source_dims: ['operational_state'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance'], example: '风险"教练暴露招致反对者反制" severity="medium" mitigation="保密沟通"' },
      { element: 'stop_loss', label: '止损条件', guiding_question: '什么条件下调整/放弃该客户策略？', prompts: ['stop_loss:{condition,deadline,trigger,owner,status}'], expected_fields: ['condition','deadline','trigger','owner','status'], source_dims: ['time_config'], methodology: ['STOP_LOSS'], ruler_keys: ['relevance'], example: '止损"若关键人离职且新人不接，则重做策略" status="armed"' },
      { element: 'concept_refs', label: '方法论概念引用', guiding_question: '依据了哪些方法论概念（ROLE_MAP/FACT_VS_TALK/MEDDICC）？', prompts: ['concept_refs:[{methodology_id,dimension_key,weight,required,hit}]'], expected_fields: ['methodology_id','dimension_key','weight','required','hit'], source_dims: [], methodology: ['ROLE_MAP','FACT_VS_TALK','MEDDICC'], ruler_keys: ['importance'], example: 'ROLE_MAP.decision_chain=hit, FACT_VS_TALK.talk_vs_fact=pending' },
    ],
  },
  SOLUTION_VALUE: {
    scenario_id: 'SOLUTION_VALUE',
    stage_label: '四、方案价值',
    scenario_note: '决策："方案如何取舍？定制边界在哪？差异化价值是否成立？"',
    elements: [
      { element: 'intent', label: '目的与核心问题', guiding_question: '方案设计要回答的核心问题？', prompts: ['目的（例：用最小定制覆盖刚需并绑定差异化指标）', '核心问题：刚需覆盖度 vs 定制成本'], expected_fields: ['purpose','question','sub_questions'], source_dims: ['identity','structure'], methodology: ['OPP_MATRIX'], ruler_keys: ['clarity'], example: '目的：用标准模块覆盖 80% 痛点；问题：定制是否超毛利' },
      { element: 'assumptions', label: '假设台账', guiding_question: '关于客户需求与成本的假设？根据？', prompts: ['假设 {text,basis,falsifiable_by}', '例：text="客户接受 90% 覆盖" basis="其痛点清单" falsifiable_by="其坚持全定制"'], expected_fields: ['id','text','basis','falsifiable_by','evidence_ref','risk_if_wrong'], source_dims: ['decision_history'], methodology: ['OPP_MATRIX'], ruler_keys: ['accuracy','fairness'], example: '假设"客户不要求源码级定制" basis="其 IT 能力弱" falsifiable_by="其安全策略"' },
      { element: 'inference', label: '推理链', guiding_question: '从需求到方案取舍的推理？', prompts: ['chain:[{evidence,via_assumption,conclusion}]'], expected_fields: ['chain','conclusion'], source_dims: ['semantics'], methodology: ['OPP_MATRIX'], ruler_keys: ['depth','logic'], example: '证据"痛点 5 项中 4 项标准覆盖" 经假设"剩余 1 项可 workaround" → 结论"不定制"' },
      { element: 'viewpoints', label: '视角覆盖', guiding_question: '售前/交付/客户各方视角？', prompts: ['viewpoints:[{stance,holder,covered}]'], expected_fields: ['stance','holder','covered'], source_dims: ['structure','semantics'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['breadth','fairness'], example: '售前"差异化绑定" / 交付"定制增负荷" / 客户"要全功能"' },
      { element: 'implications', label: '意涵与连锁后果', guiding_question: '方案取舍的连锁后果？', prompts: ['implications:[{type,text,probability,mitigation}]'], expected_fields: ['type','text','probability','mitigation'], source_dims: ['operational_state','time_config'], methodology: ['OPP_MATRIX','RISK_TRADEOFF'], ruler_keys: ['relevance','logic'], example: '负面"定制成本>毛利" probability=0.2 mitigation="改报价结构"' },
      { element: 'risk_register', label: '风险清单', guiding_question: '方案风险？', prompts: ['risk_register:[{risk,severity,evidence,mitigation,owner}]'], expected_fields: ['risk','severity','evidence','mitigation','owner'], source_dims: ['operational_state'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance'], example: '风险"差异化指标客户不认" severity="high" mitigation="提前 PoC 验证"' },
      { element: 'stop_loss', label: '止损条件', guiding_question: '什么条件下收回定制承诺？', prompts: ['stop_loss:{condition,deadline,trigger,owner,status}'], expected_fields: ['condition','deadline','trigger','owner','status'], source_dims: ['time_config'], methodology: ['STOP_LOSS'], ruler_keys: ['relevance'], example: '止损"若 PoC 不通过则回到标准方案" status="armed"' },
      { element: 'concept_refs', label: '方法论概念引用', guiding_question: '依据了哪些方法论概念（OPP_MATRIX/RISK_TRADEOFF）？', prompts: ['concept_refs:[{methodology_id,dimension_key,weight,required,hit}]'], expected_fields: ['methodology_id','dimension_key','weight','required','hit'], source_dims: [], methodology: ['OPP_MATRIX','RISK_TRADEOFF'], ruler_keys: ['importance'], example: 'OPP_MATRIX.need_covered=hit, RISK_TRADEOFF.custom_cost=pending' },
    ],
  },
  QUOTE_PRICING: {
    scenario_id: 'QUOTE_PRICING',
    stage_label: '五、商务报价',
    scenario_note: '决策："三级报价如何定？折扣换什么条件？让步边界与付款风险？"',
    elements: [
      { element: 'intent', label: '目的与核心问题', guiding_question: '本次报价要达成的核心目的？', prompts: ['目的（例：保住毛利红线同时换取签约）', '核心问题：开盘/目标/底价对比', '子问题：折扣对等条件'], expected_fields: ['purpose','question','sub_questions'], source_dims: ['identity','structure'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['clarity'], example: '目的：8 折换年框；问题：折扣是否超权限需审批' },
      { element: 'assumptions', label: '假设台账', guiding_question: '关于客户预算与竞品的假设？', prompts: ['假设 {text,basis,falsifiable_by}', '例：text="客户预算≥X" basis="其规模" falsifiable_by="其压价"'], expected_fields: ['id','text','basis','falsifiable_by','evidence_ref','risk_if_wrong'], source_dims: ['decision_history'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['accuracy','fairness'], example: '假设"竞品报价相近" basis="其历史" falsifiable_by="其突然降价"' },
      { element: 'inference', label: '推理链', guiding_question: '从成本底价到报价位的推理？', prompts: ['chain:[{evidence,via_assumption,conclusion}]'], expected_fields: ['chain','conclusion'], source_dims: ['semantics'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['depth','logic'], example: '证据"底价 85 折" 经假设"客户要 8 折" → 结论"需审批+换条件"' },
      { element: 'viewpoints', label: '视角覆盖', guiding_question: '商务/售前/交付/财务视角？', prompts: ['viewpoints:[{stance,holder,covered}]'], expected_fields: ['stance','holder','covered'], source_dims: ['structure','semantics'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['breadth','fairness'], example: '商务"争签约" / 财务"守毛利" / 交付"防范围蔓延"' },
      { element: 'implications', label: '意涵与连锁后果', guiding_question: '报价让步的连锁后果？', prompts: ['implications:[{type,text,probability,mitigation}]'], expected_fields: ['type','text','probability','mitigation'], source_dims: ['operational_state','time_config'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance','logic'], example: '负面"折扣超权限未批则违规" probability=0.4 mitigation="走 CRM_APPROVAL_FLOW"' },
      { element: 'risk_register', label: '风险清单', guiding_question: '报价风险（毛利红线/付款比例/维保）？', prompts: ['risk_register:[{risk,severity,evidence,mitigation,owner}]'], expected_fields: ['risk','severity','evidence','mitigation','owner'], source_dims: ['operational_state'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance'], example: '风险"付款比例过低" severity="high" mitigation="分期+质保金"' },
      { element: 'stop_loss', label: '止损条件', guiding_question: '什么条件下撤回报价/冻结折扣？', prompts: ['stop_loss:{condition,deadline,trigger,owner,status}'], expected_fields: ['condition','deadline','trigger','owner','status'], source_dims: ['time_config'], methodology: ['STOP_LOSS'], ruler_keys: ['relevance'], example: '止损"报价有效期 15 天，过期未签则重审" status="armed"' },
      { element: 'concept_refs', label: '方法论概念引用', guiding_question: '依据了哪些方法论概念（RISK_TRADEOFF/STOP_LOSS）？', prompts: ['concept_refs:[{methodology_id,dimension_key,weight,required,hit}]'], expected_fields: ['methodology_id','dimension_key','weight','required','hit'], source_dims: [], methodology: ['RISK_TRADEOFF','STOP_LOSS'], ruler_keys: ['importance'], example: 'RISK_TRADEOFF.price_vs_floor=hit, STOP_LOSS.discount_redline=pending' },
    ],
  },
  SIGN_RISK: {
    scenario_id: 'SIGN_RISK',
    stage_label: '六、签单前风险',
    scenario_note: '决策："签单前风险是否可控？卡住时采取什么策略？"',
    elements: [
      { element: 'intent', label: '目的与核心问题', guiding_question: '签单前风险决策的核心问题？', prompts: ['目的（例：识别反对者并化解）', '核心问题：风险是否可控'], expected_fields: ['purpose','question','sub_questions'], source_dims: ['identity','structure'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['clarity'], example: '目的：化解生产总监顾虑；问题：反对者级别是否致命' },
      { element: 'assumptions', label: '假设台账', guiding_question: '关于交付能力与客户经营状况的假设？', prompts: ['假设 {text,basis,falsifiable_by}'], expected_fields: ['id','text','basis','falsifiable_by','evidence_ref','risk_if_wrong'], source_dims: ['decision_history'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['accuracy','fairness'], example: '假设"客户经营稳健" basis="其年报" falsifiable_by="其延迟付款"' },
      { element: 'inference', label: '推理链', guiding_question: '从风险信号到"可控/卡住"的推理？', prompts: ['chain:[{evidence,via_assumption,conclusion}]'], expected_fields: ['chain','conclusion'], source_dims: ['semantics'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['depth','logic'], example: '证据"反对者为中层" 经假设"可向上沟通" → 结论"可控"' },
      { element: 'viewpoints', label: '视角覆盖', guiding_question: '反对者/支持者/交付视角？', prompts: ['viewpoints:[{stance,holder,covered}]'], expected_fields: ['stance','holder','covered'], source_dims: ['structure','semantics'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['breadth','fairness'], example: '反对"财务怕超预算" / 支持"生产要效率"' },
      { element: 'implications', label: '意涵与连锁后果', guiding_question: '签单风险误判的连锁后果？', prompts: ['implications:[{type,text,probability,mitigation}]'], expected_fields: ['type','text','probability','mitigation'], source_dims: ['operational_state','time_config'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance','logic'], example: '负面"签后交付暴雷" probability=0.15 mitigation="分期+验收量化"' },
      { element: 'risk_register', label: '风险清单', guiding_question: '签单前风险清单？', prompts: ['risk_register:[{risk,severity,evidence,mitigation,owner}]'], expected_fields: ['risk','severity','evidence','mitigation','owner'], source_dims: ['operational_state'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance'], example: '风险"需求变更量过大" severity="high" mitigation="锁定范围"' },
      { element: 'stop_loss', label: '止损条件', guiding_question: '什么条件下暂停签单？', prompts: ['stop_loss:{condition,deadline,trigger,owner,status}'], expected_fields: ['condition','deadline','trigger','owner','status'], source_dims: ['time_config'], methodology: ['STOP_LOSS'], ruler_keys: ['relevance'], example: '止损"若验收标准未量化则不予签" status="armed"' },
      { element: 'concept_refs', label: '方法论概念引用', guiding_question: '依据了哪些方法论概念（RISK_TRADEOFF/STOP_LOSS）？', prompts: ['concept_refs:[{methodology_id,dimension_key,weight,required,hit}]'], expected_fields: ['methodology_id','dimension_key','weight','required','hit'], source_dims: [], methodology: ['RISK_TRADEOFF','STOP_LOSS'], ruler_keys: ['importance'], example: 'RISK_TRADEOFF.opposer_level=hit, STOP_LOSS.sign_redline=pending' },
    ],
  },
  POST_CONTRACT: {
    scenario_id: 'POST_CONTRACT',
    stage_label: '七、终局决策',
    scenario_note: '决策："需求变更/回款策略/续约/丢单孵化放弃如何决？"',
    elements: [
      { element: 'intent', label: '目的与核心问题', guiding_question: '合同执行期终局决策的核心问题？', prompts: ['目的（例：保回款+孵化续约）', '核心问题：变更/回款/续约/放弃如何取舍'], expected_fields: ['purpose','question','sub_questions'], source_dims: ['identity','structure'], methodology: ['OPP_MATRIX'], ruler_keys: ['clarity'], example: '目的：催回款同时孵化增购；问题：逾期原因是否结构性' },
      { element: 'assumptions', label: '假设台账', guiding_question: '关于客户满意度与续约价值的假设？', prompts: ['假设 {text,basis,falsifiable_by}'], expected_fields: ['id','text','basis','falsifiable_by','evidence_ref','risk_if_wrong'], source_dims: ['decision_history'], methodology: ['OPP_MATRIX'], ruler_keys: ['accuracy','fairness'], example: '假设"客户满意" basis="其续约意向" falsifiable_by="其投诉"' },
      { element: 'inference', label: '推理链', guiding_question: '从履约信号到终局动作的推理？', prompts: ['chain:[{evidence,via_assumption,conclusion}]'], expected_fields: ['chain','conclusion'], source_dims: ['semantics'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['depth','logic'], example: '证据"逾期因预算周期" 经假设"非信任问题" → 结论"可续约"' },
      { element: 'viewpoints', label: '视角覆盖', guiding_question: '财务/客户成功/销售视角？', prompts: ['viewpoints:[{stance,holder,covered}]'], expected_fields: ['stance','holder','covered'], source_dims: ['structure','semantics'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['breadth','fairness'], example: '财务"催回款" / 客户成功"保满意" / 销售"争增购"' },
      { element: 'implications', label: '意涵与连锁后果', guiding_question: '终局动作的连锁后果？', prompts: ['implications:[{type,text,probability,mitigation}]'], expected_fields: ['type','text','probability','mitigation'], source_dims: ['operational_state','time_config'], methodology: ['OPP_MATRIX','RISK_TRADEOFF'], ruler_keys: ['relevance','logic'], example: '负面"放弃过早失战略客户" probability=0.1 mitigation="长周期孵化"' },
      { element: 'risk_register', label: '风险清单', guiding_question: '回款/变更风险？', prompts: ['risk_register:[{risk,severity,evidence,mitigation,owner}]'], expected_fields: ['risk','severity','evidence','mitigation','owner'], source_dims: ['operational_state'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance'], example: '风险"逾期恶化" severity="high" mitigation="法务介入"' },
      { element: 'stop_loss', label: '止损条件', guiding_question: '什么条件下放弃/移交？', prompts: ['stop_loss:{condition,deadline,trigger,owner,status}'], expected_fields: ['condition','deadline','trigger','owner','status'], source_dims: ['time_config'], methodology: ['STOP_LOSS'], ruler_keys: ['relevance'], example: '止损"逾期超 90 天且无沟通则法务" status="armed"' },
      { element: 'concept_refs', label: '方法论概念引用', guiding_question: '依据了哪些方法论概念（RISK_TRADEOFF/OPP_MATRIX）？', prompts: ['concept_refs:[{methodology_id,dimension_key,weight,required,hit}]'], expected_fields: ['methodology_id','dimension_key','weight','required','hit'], source_dims: [], methodology: ['RISK_TRADEOFF','OPP_MATRIX'], ruler_keys: ['importance'], example: 'OPP_MATRIX.contract_scope=hit, RISK_TRADEOFF.overdue_reason=pending' },
    ],
  },
  LOSS_REVIEW: {
    scenario_id: 'LOSS_REVIEW',
    stage_label: '八、丢单复盘',
    scenario_note: '决策："放弃 / 长期孵化（丢单后如何复盘与孵化）？"',
    elements: [
      { element: 'intent', label: '目的与核心问题', guiding_question: '丢单复盘要回答的核心问题？', prompts: ['目的（例：萃取教训+判断是否值得长期孵化）', '核心问题：真因 vs 话术', '子问题：未来预算/痛点长期性'], expected_fields: ['purpose','question','sub_questions'], source_dims: ['identity','structure'], methodology: ['FACT_VS_TALK'], ruler_keys: ['clarity'], example: '目的：区分"真丢"与"暂冻"；问题：Coach 情报是否真实' },
      { element: 'assumptions', label: '假设台账', guiding_question: '关于丢单真因的假设？根据与可推翻？', prompts: ['假设 {text,basis,falsifiable_by}', '例：text="因价格丢" basis="其说辞" falsifiable_by="其选竞品非最低价"'], expected_fields: ['id','text','basis','falsifiable_by','evidence_ref','risk_if_wrong'], source_dims: ['decision_history'], methodology: ['FACT_VS_TALK'], ruler_keys: ['accuracy','fairness'], example: '假设"对手关系更深" basis="Coach 情报" falsifiable_by="公开招标"' },
      { element: 'inference', label: '推理链', guiding_question: '从话术到真因的推理（FACT_VS_TALK）？', prompts: ['chain:[{evidence,via_assumption,conclusion}]'], expected_fields: ['chain','conclusion'], source_dims: ['semantics'], methodology: ['FACT_VS_TALK'], ruler_keys: ['depth','logic'], example: '证据"客户说价格高却选更贵竞品" 经假设"真实因关系" → 结论"非价格真因"' },
      { element: 'viewpoints', label: '视角覆盖', guiding_question: '销售/售前/客户内部视角？', prompts: ['viewpoints:[{stance,holder,covered}]'], expected_fields: ['stance','holder','covered'], source_dims: ['structure','semantics'], methodology: ['OPP_MATRIX'], ruler_keys: ['breadth','fairness'], example: '销售"我以为价格" / 售前"其实关系" / 客户"未明说"' },
      { element: 'implications', label: '意涵与连锁后果', guiding_question: '孵化 vs 放弃的连锁后果？', prompts: ['implications:[{type,text,probability,mitigation}]'], expected_fields: ['type','text','probability','mitigation'], source_dims: ['operational_state','time_config'], methodology: ['OPP_MATRIX'], ruler_keys: ['relevance','logic'], example: '正面"长期孵化转介绍" / 负面"空耗跟进资源"' },
      { element: 'risk_register', label: '风险清单', guiding_question: '孵化风险？', prompts: ['risk_register:[{risk,severity,evidence,mitigation,owner}]'], expected_fields: ['risk','severity','evidence','mitigation','owner'], source_dims: ['operational_state'], methodology: ['RISK_TRADEOFF'], ruler_keys: ['relevance'], example: '风险"内部支持者离职" severity="medium" mitigation="发展新城服"' },
      { element: 'stop_loss', label: '止损条件', guiding_question: '什么条件下彻底放弃？', prompts: ['stop_loss:{condition,deadline,trigger,owner,status}'], expected_fields: ['condition','deadline','trigger','owner','status'], source_dims: ['time_config'], methodology: ['STOP_LOSS'], ruler_keys: ['relevance'], example: '止损"2 年内无预算信号则归档" status="armed"' },
      { element: 'concept_refs', label: '方法论概念引用', guiding_question: '依据了哪些方法论概念（FACT_VS_TALK/OPP_MATRIX）？', prompts: ['concept_refs:[{methodology_id,dimension_key,weight,required,hit}]'], expected_fields: ['methodology_id','dimension_key','weight','required','hit'], source_dims: [], methodology: ['FACT_VS_TALK','OPP_MATRIX'], ruler_keys: ['importance'], example: 'FACT_VS_TALK.talk_vs_fact=hit, OPP_MATRIX.strategic_value=pending' },
    ],
  },
};

/**
 * 取某场景的思维要素拆解（未注册则返回通用 8 要素骨架，保证不静默、不抛错）。
 * @param {string} scenarioId
 * @returns {{scenario_id:string, stage_label:string|null, scenario_note:string, elements: ElementDecomp[], generic:boolean}}
 */
export function getThinkingTemplate(scenarioId) {
  if (scenarioId && TEMPLATES[scenarioId]) {
    return { ...TEMPLATES[scenarioId], generic: false };
  }
  // 通用兜底：8 要素标准提问，不绑定具体业务（避免"无模板=表单空"假绿）
  return {
    scenario_id: scenarioId || 'UNKNOWN',
    stage_label: null,
    scenario_note: '',
    generic: true,
    elements: [
      { element: 'intent', label: '目的与核心问题', guiding_question: '这次决策的真实目的与核心问题是什么？', prompts: ['purpose', 'question', 'sub_questions'], expected_fields: ['purpose', 'question', 'sub_questions'], source_dims: [], methodology: [], ruler_keys: ['clarity'], example: '' },
      { element: 'assumptions', label: '假设台账', guiding_question: '基于哪些假设？每条的根据与可推翻条件？', prompts: ['text', 'basis', 'falsifiable_by', 'evidence_ref'], expected_fields: ['id', 'text', 'basis', 'falsifiable_by', 'evidence_ref', 'risk_if_wrong'], source_dims: [], methodology: [], ruler_keys: ['accuracy', 'fairness'], example: '' },
      { element: 'inference', label: '推理链', guiding_question: '推理链是否证据充分、逻辑无环？', prompts: ['chain[].evidence', 'chain[].via_assumption', 'conclusion'], expected_fields: ['chain', 'conclusion'], source_dims: [], methodology: [], ruler_keys: ['depth', 'logic'], example: '' },
      { element: 'viewpoints', label: '视角覆盖', guiding_question: '哪些视角已覆盖？是否含反方？', prompts: ['stance', 'holder', 'covered'], expected_fields: ['stance', 'holder', 'covered'], source_dims: [], methodology: [], ruler_keys: ['breadth', 'fairness'], example: '' },
      { element: 'implications', label: '意涵与连锁后果', guiding_question: '升级/决策的连锁后果？正负面与缓解？', prompts: ['type', 'text', 'probability', 'mitigation'], expected_fields: ['type', 'text', 'probability', 'mitigation'], source_dims: [], methodology: [], ruler_keys: ['relevance', 'logic'], example: '' },
      { element: 'risk_register', label: '风险清单', guiding_question: '判断错误有哪些风险？', prompts: ['risk', 'severity', 'evidence', 'mitigation', 'owner'], expected_fields: ['risk', 'severity', 'evidence', 'mitigation', 'owner'], source_dims: [], methodology: [], ruler_keys: ['relevance'], example: '' },
      { element: 'stop_loss', label: '止损条件', guiding_question: '什么条件下撤销/冻结本次决策？', prompts: ['condition', 'deadline', 'trigger', 'owner', 'status'], expected_fields: ['condition', 'deadline', 'trigger', 'owner', 'status'], source_dims: [], methodology: [], ruler_keys: ['relevance'], example: '' },
      { element: 'concept_refs', label: '方法论概念引用', guiding_question: '依据了哪些方法论概念？必填且命中？', prompts: ['methodology_id', 'dimension_key', 'required', 'hit'], expected_fields: ['methodology_id', 'dimension_key', 'weight', 'required', 'hit'], source_dims: [], methodology: [], ruler_keys: ['importance'], example: '' },
    ],
  };
}

/**
 * 生成写前思维骨架（Pre 阶段草稿）。
 * 把场景的思维要素拆解（方法论提问）与场景运行配置（focus/required_dims）合并，
 * 产出可供决策表单直接渲染的 8 要素填空骨架 + 真实七维供给提示（preContext）。
 *
 * @param {string} scenarioId
 * @param {object} [opts]
 *   - scenario {object}  决策场景运行配置（focus_elements/focus_rulers/required_dims/stage/rubric_pass_line/retro_required），可来自 decision_scenario 行；缺省取模板内置
 *   - preContext {object} assembleContextV2({phase:'pre',persist:false}) 结果（prompt_block/dim_coverage/supplied_dims）
 * @returns {object} { scenario_id, stage_label, scenario_note, thinking_skeleton:[8], focus_elements, focus_rulers, required_dims, rubric_pass_line, retro_required, pre_context }
 */
export function buildPreContext(scenarioId, opts = {}) {
  const tpl = getThinkingTemplate(scenarioId);
  const scenario = opts.scenario || {};
  // 八要素骨架：把模板 prompts/expected_fields 与场景 focus 加权标注合并
  const focusKeys = new Set(
    (Array.isArray(scenario.focus_elements) ? scenario.focus_elements : [])
      .map((f) => (typeof f === 'string' ? f : f && f.key))
      .filter(Boolean)
  );
  const thinkingSkeleton = tpl.elements.map((el) => ({
    element: el.element,
    label: el.label,
    guiding_question: el.guiding_question,
    prompts: el.prompts,
    expected_fields: el.expected_fields,
    source_dims: el.source_dims,
    methodology: el.methodology,
    ruler_keys: el.ruler_keys,
    example: el.example,
    focus: focusKeys.has(el.element), // 本场景是否聚焦要素（×1.5，见 §6.2）
  }));
  return {
    scenario_id: scenarioId,
    stage_label: scenario.stage || tpl.stage_label,
    scenario_note: tpl.scenario_note,
    generic: tpl.generic,
    thinking_skeleton: thinkingSkeleton,
    focus_elements: scenario.focus_elements || null,
    focus_rulers: scenario.focus_rulers || null,
    required_dims: scenario.required_dims || null,
    rubric_pass_line: scenario.rubric_pass_line ?? null,
    retro_required: scenario.retro_required ?? null,
    pre_context: opts.preContext || null, // 七维供给提示（真实流量时由 assembleContextV2 填充）
  };
}

export { TEMPLATES };
