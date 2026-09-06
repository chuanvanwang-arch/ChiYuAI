# P0-② + P2/P3 前端可视化接入 合并实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已落地的 P0-② 思维要素模板（8 场景）、P2 闭环回流、P3 知识沉淀接入前端，让"销售7–8大决策×8要素×九尺子"在监控台弹窗与配置中心**可见、可配、可操作**；并把 P2/P3 闭环/知识看板接入销售决策监控台。

**Architecture:** 八要素唯一事实源 = `src/decision/thinkingTemplates.js`（代码层，不进 schema）；前端两页（监控台弹窗 + config 总览）只读消费既有/新增 API。P2/P3 纯接已有后端端点（除 §4.2 system skill 种子），零新增后端逻辑端点。弹窗 `attrib-modal` 被两设计文档共用，合并为一个改造 Task（页签：7维快照 / 思维要素 / 闭环）。

**Tech Stack:** Node 22 ESM + Express 4（既有）；前端原生内联 HTML + `tokens.css` 语义变量 + `fetch`；PostgreSQL 16（skill_scope / decision_scenario 已存在）。

**铁律（跨会话）：** 零硬编码色值（全走 tokens.css）；未登录端点返 401 前端显"请先登录"；不造假填充（空显"暂无数据"）；每 Task 一 commit（沙箱无凭证，用户本地按功能线提交，署名 `Co-Authored-By: 王川 <watchm@163.com>`，禁 `git add -A`）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/decision/thinkingTemplates.js` | Modify | TEMPLATES 注册表补 7 场景 8 要素（Task A） |
| `test/decision/thinkingTemplate.test.js` | Modify | 断言全部 8 场景 buildPreContext 返回 8 elements（Task A） |
| `src/http/decisionReadRoutes.js` | Modify | 新增 `GET /api/decision/thinking-templates`（Task B） |
| `db/migrate.js` | Modify | 幂等插入 system 层 skill_scope 种子（Task E） |
| `src/web/sales-decision-monitor.html` | Modify | `#closure-loop` 看板 + `attrib-modal` 页签改造（Task F） |
| `src/portal/configCenter.js` | Modify | CONFIG_ITEMS 新增 id:33（Task G） |
| `src/web/decision-thinking.html` | Create | 8 大决策 8 要素×九尺子 只读总览页（Task G） |
| `src/web/config.html` | Modify | 追加 `#skill-scope` section（Task G） |

依赖序：A → B → E（独立）→ F（依赖 B 的 pre-context 既有 + P2/P3 端点既有）→ G（依赖 E 种子 + 端点既有）。

---

## Task A: thinkingTemplates 补全 7 场景 8 要素

**Files:**
- Modify: `src/decision/thinkingTemplates.js:160`（在 `LEAD_FOLLOW_UP` 结束 `},` 后、`};` 前插入 7 个 key）
- Test: `test/decision/thinkingTemplate.test.js`

- [ ] **Step 1: 写失败断言（扩展既有单测）**

在 `test/decision/thinkingTemplate.test.js` 末尾追加：

```js
import { buildPreContext, getThinkingTemplate, TEMPLATES } from '../../src/decision/thinkingTemplates.js';

const ALL_SCENARIOS = ['LEAD_FOLLOW_UP','OPP_QUALIFY','CLIENT_STRATEGY','SOLUTION_VALUE','QUOTE_PRICING','SIGN_RISK','POST_CONTRACT','LOSS_REVIEW'];

test('全部 8 销售场景均返回 8 要素（含新增 7 场景）', () => {
  for (const sid of ALL_SCENARIOS) {
    const r = buildPreContext(sid);
    expect(r.thinking_skeleton, `场景 ${sid} 要素数`).toHaveLength(8);
    // 八要素列序铁律
    const seq = r.thinking_skeleton.map((e) => e.element);
    expect(seq).toEqual(['intent','assumptions','inference','viewpoints','implications','risk_register','stop_loss','concept_refs']);
  }
});

test('新增 7 场景均为作者化（generic=false）且绑定方法论', () => {
  const authored = ALL_SCENARIOS.filter((s) => s !== 'LEAD_FOLLOW_UP');
  for (const sid of authored) {
    const t = getThinkingTemplate(sid);
    expect(t.generic, `${sid} 应非 generic`).toBe(false);
    const methods = new Set(t.elements.flatMap((e) => e.methodology));
    expect(methods.size, `${sid} 应绑定≥1方法论`).toBeGreaterThan(0);
  }
});

test('OPP_QUALIFY 绑定 MEDDICC/OPP_MATRIX/ROLE_MAP', () => {
  const t = getThinkingTemplate('OPP_QUALIFY');
  const methods = new Set(t.elements.flatMap((e) => e.methodology));
  expect(methods.has('MEDDICC')).toBe(true);
  expect(methods.has('OPP_MATRIX')).toBe(true);
  expect(methods.has('ROLE_MAP')).toBe(true);
});
```

- [ ] **Step 2: 运行单测确认失败（仅 LEAD_FOLLOW_UP 有实例）**

Run: `cd D:/system/CRM-ai-native && C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe node_modules/.bin/vitest run test/decision/thinkingTemplate.test.js`
Expected: FAIL（OPP_QUALIFY 等返 generic，断言 `generic=false` 不过）

- [ ] **Step 3: 在 TEMPLATES 插入 7 个场景完整 8 要素**

在 `src/decision/thinkingTemplates.js` 第 159 行（`LEAD_FOLLOW_UP` 的 `},`）之后、`};`（第 160 行）之前，插入以下 7 个场景。**结构严格对齐 LEAD_FOLLOW_UP**（八要素顺序、字段名一致；内容按 `db/seed.sql` 各场景 `methodology_ids` + `eval_dimensions` 实例化；stage_label 取 seed `stage`；scenario_note 取 seed `description`）：

```js
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
```

- [ ] **Step 4: 运行单测确认通过**

Run: 同 Step 2
Expected: PASS（8 场景均 8 要素、新增 7 场景 generic=false）

- [ ] **Step 5: Commit**

```bash
cd D:/system/CRM-ai-native
git add src/decision/thinkingTemplates.js test/decision/thinkingTemplate.test.js
git commit -m "feat(P0-②): thinkingTemplates 补全 7 销售场景 8 要素×九尺子

Co-Authored-By: 王川 <watchm@163.com>"
```

---

## Task B: 新增 GET /api/decision/thinking-templates 端点

**Files:**
- Modify: `src/http/decisionReadRoutes.js`（在 pre-context 端点附近新增）

- [ ] **Step 1: 写失败断言**

在 `test/decision/` 新建 `thinkingTemplatesApi.test.js`：

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// 用内存/测试库桩：直接单测路由处理函数较复杂，改为对 getThinkingTemplate 聚合逻辑的纯函数测试
import { getThinkingTemplate } from '../../src/decision/thinkingTemplates.js';

describe('thinking-templates 聚合契约', () => {
  const SCN = ['LEAD_FOLLOW_UP','OPP_QUALIFY','CLIENT_STRATEGY','SOLUTION_VALUE','QUOTE_PRICING','SIGN_RISK','POST_CONTRACT','LOSS_REVIEW'];
  it('逐个场景返回 8 要素且含 stage_label', () => {
    for (const s of SCN) {
      const t = getThinkingTemplate(s);
      expect(t.elements).toHaveLength(8);
      expect(typeof t.stage_label).toBe('string');
    }
  });
});
```

（端点集成测试依赖 db，本 Task 以纯函数契约 + 实现后手测端点为准；集成回归见 Task F 浏览器验证）

- [ ] **Step 2: 在 decisionReadRoutes.js 注册端点**

在 `app.get('/api/decision/pre-context'` 块（约第 108 行 `});` 之后）插入：

```js
  // P0-② 批量思维模板（配置中心只读总览）：逐销售场景返回 8 要素拆解
  app.get('/api/decision/thinking-templates', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const { rows } = await pool.query(
        `SELECT scenario_id, stage, description FROM crm.decision_scenario WHERE stage <> 'meta' ORDER BY stage`
      );
      const items = rows.map((r) => {
        const t = getThinkingTemplate(r.scenario_id);
        return {
          scenario_id: r.scenario_id,
          stage: r.stage,
          scenario_note: t.scenario_note || r.description || '',
          generic: t.generic,
          elements: t.elements,
        };
      });
      res.json({ ok: true, items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
```

- [ ] **Step 3: 运行纯函数测试**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe node_modules/.bin/vitest run test/decision/thinkingTemplatesApi.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd D:/system/CRM-ai-native
git add src/http/decisionReadRoutes.js test/decision/thinkingTemplatesApi.test.js
git commit -m "feat(P0-②): 新增 GET /api/decision/thinking-templates 批量思维模板端点

Co-Authored-By: 王川 <watchm@163.com>"
```

---

## Task E: migrate 幂等插入 system 层 skill 种子

**Files:**
- Modify: `db/migrate.js`（在既有 skill_scope 表创建之后插入种子；若 migrate 无 skill_scope 创建段，则先确认 `src/skill/skillScope.js` 的建表已在别处，本 Task 仅插入）

- [ ] **Step 1: 确认 skill_scope 表已在 schema/migrate 创建**

Run: `cd D:/system/CRM-ai-native && grep -rn "skill_scope" db/schema.sql db/migrate.js | head`

若表中无 CREATE，则在 `db/migrate.js` 顶部 ensure 段补 `CREATE TABLE IF NOT EXISTS crm.skill_scope (...)`（字段对齐 skillScope.js：`id uuid pk default gen_random_uuid(), skill text, scope_level text, owner text, enabled boolean default true, promoted_from text, note text, created_at timestamptz default now()` + 唯一索引 `(skill, scope_level, COALESCE(owner,''))`）。

- [ ] **Step 2: 插入 system 层种子（幂等）**

在 migrate 的 seed 段追加（skill 名取自 `src/agent/agentSpec.js` 的 skillCalls 并集；若无法静态解析，用以下已知 CRM 业务 skill 基线集合）：

```sql
-- P3 D2 system 层 skill 基线（展示基线，真实配置事实；ON CONFLICT 幂等）
INSERT INTO crm.skill_scope (skill, scope_level, owner, enabled, promoted_from) VALUES
  ('data-particle-read','system',NULL,true,NULL),
  ('data-particle-attr-read','system',NULL,true,NULL),
  ('method-stage-progression-engine','system',NULL,true,NULL),
  ('method-funnel-classification-engine','system',NULL,true,NULL),
  ('method-behavior-standard-engine','system',NULL,true,NULL),
  ('method-quote-engine','system',NULL,true,NULL),
  ('method-review-gate-engine','system',NULL,true,NULL),
  ('method-intake-routing-engine','system',NULL,true,NULL),
  ('crm-deal-advance','system',NULL,true,NULL),
  ('crm-order-advance','system',NULL,true,NULL)
ON CONFLICT (skill, scope_level, COALESCE(owner,'')) DO NOTHING;
```

> 实施时以 `src/agent/agentSpec.js` 实际 skillCalls 并集为准（grep `skillCalls` 取并集），替换上表为真实 skill 名列表。

- [ ] **Step 3: 跑 migrate 验证（测试库，零残留）**

Run: `cd D:/system/CRM-ai-native && SET PGDATABASE=crm_native_test && C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe scripts/seed-test-config.mjs && C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe db/migrate.js`
Expected: 无报错；`SELECT count(*) FROM crm.skill_scope WHERE scope_level='system'` ≥ 上述条数。

- [ ] **Step 4: Commit**

```bash
cd D:/system/CRM-ai-native
git add db/migrate.js
git commit -m "feat(P3): migrate 幂等插入 system 层 skill_scope 展示基线

Co-Authored-By: 王川 <watchm@163.com>"
```

---

## Task F: 监控台接入闭环/知识 + 弹窗思维要素页签

**Files:**
- Modify: `src/web/sales-decision-monitor.html`（#closure-loop section + attrib-modal 页签）

### F.1 全局闭环活度看板（在 #true-graph section 之后插入）

- [ ] **Step 1: 插入 section HTML（约第 417 行后）**

```html
<section id="closure-loop" class="dn-section">
  <h2>闭环活度看板（P2/P3 · 真实流量）</h2>
  <div class="cl-cards">
    <div class="card cl-card" id="cl-deviation">
      <h3>偏差处方 (C3)</h3>
      <div class="cl-body dn-empty">加载中…</div>
    </div>
    <div class="card cl-card" id="cl-qskill">
      <h3>Q(Skill,T) 改善 (C5)</h3>
      <div class="cl-body dn-empty">加载中…</div>
    </div>
    <div class="card cl-card" id="cl-concept">
      <h3>知识概念覆盖 (D3)</h3>
      <div class="cl-body dn-empty">加载中…</div>
    </div>
  </div>
</section>
```

- [ ] **Step 2: 插入加载逻辑（在 `loadLoops();` 附近追加）**

```js
async function loadClosureLoop() {
  const safeJson = async (url) => { try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; } };
  // ① 偏差
  const dv = await safeJson('/api/decision/monitor/deviation?windowDays=90');
  const dvBox = document.querySelector('#cl-deviation .cl-body');
  if (dv && dv.deviation) {
    const d = dv.deviation;
    const over = d.over != null && d.total ? d.over / d.total : 0;
    const cls = (d.total && over > (d.threshold || 0)) ? 'bad' : 'good';
    dvBox.className = 'cl-body';
    dvBox.innerHTML = `<span class="sdim ${cls}">偏差率 ${(d.rate != null ? (d.rate*100).toFixed(1) : '—')}%</span> / 阈值 ${(d.threshold!=null?(d.threshold*100).toFixed(0):'—')}%<br>超阈 ${d.over||0} / 共 ${d.total||0}`;
  } else if (dvBox) { dvBox.textContent = '窗口内无决策，暂无偏差率'; }
  // ② Q(Skill,T)
  const qs = await safeJson('/api/decision/monitor/q-skill?windowDays=90');
  const qsBox = document.querySelector('#cl-qskill .cl-body');
  if (qs && Array.isArray(qs.skills) && qs.skills.length) {
    qsBox.className = 'cl-body';
    qsBox.innerHTML = qs.skills.map((s) => `<div class="cl-row"><code>${s.scenario_id||''}·${s.skill||''}</code> q0→qN <b class="${s.improved?'good':'warn'}">${s.improved?'改善':'停滞'}</b></div>`).join('');
  } else if (qsBox) { qsBox.textContent = '暂无采样'; }
  // ③ 概念覆盖（当前选中场景；无选中时显提示）
  const cs = document.querySelector('#scenario-filter')?.value || '';
  const cv = cs ? await safeJson('/api/knowledge/concept-vectors?scenario_id=' + encodeURIComponent(cs)) : null;
  const cvBox = document.querySelector('#cl-concept .cl-body');
  if (cv && cv.count != null) {
    cvBox.className = 'cl-body';
    cvBox.innerHTML = `概念向量 <b>${cv.count}</b> 条` + (cv.vectors ? `<br>` + cv.vectors.slice(0,8).map((v)=>`<span class="sdim neutral">${v.methodology_id}·${v.dim_key}</span>`).join('') : '');
  } else if (cvBox) { cvBox.textContent = cs ? '无概念向量' : '选择一个场景查看概念覆盖'; }
}
loadClosureLoop();
setInterval(loadClosureLoop, 30000);
```

> 若页面无 `#scenario-filter` 元素，第 ③ 步改用第一个决策场景或固定 `LEAD_FOLLOW_UP`（实施时按页面实际 DOM 调整；空策略保持"选择场景查看"）。

### F.2 attrib-modal 加页签（7维快照 / 思维要素 / 闭环）

- [ ] **Step 3: 改弹窗 HTML（第 428-437 行）为页签结构**

```html
<div id="attrib-modal" class="dn-modal" style="display:none">
  <div class="dn-modal-panel">
    <div class="dn-modal-head">
      <div class="dn-modal-title">决策质量 · 单次决策穿透
        <crm-button class="dn-close" onclick="closeAttribModal()">×</crm-button>
      </div>
      <div class="dn-tabrow" id="attrib-tabs">
        <crm-button class="dn-tab active" data-v="snap" onclick="attribSwitch('snap')">7维快照</crm-button>
        <crm-button class="dn-tab" data-v="thinking" onclick="attribSwitch('thinking')">思维要素(8要素×九尺子)</crm-button>
        <crm-button class="dn-tab" data-v="loop" onclick="attribSwitch('loop')">闭环写回</crm-button>
      </div>
    </div>
    <div class="dn-modal-body" id="attrib-modal-body"></div>
  </div>
</div>
```

- [ ] **Step 4: 改造 drillGateAttribution 支持页签 + 思维要素/闭环渲染**

将 `drillGateAttribution(scenarioId)`（第 706 行）改为：保存当前 scenarioId 到模块变量 `currentAttribScenario`，默认渲染 snap；新增 `attribSwitch(v)`、`loadAttribThinking()`、`renderAttribLoop()`。

```js
let currentAttribScenario = null;
async function drillGateAttribution(scenarioId) {
  currentAttribScenario = scenarioId;
  const panel = document.getElementById('attrib-modal');
  const body = document.getElementById('attrib-modal-body');
  if (!panel || !body) return;
  panel.style.display = 'flex';
  attribSwitch('snap'); // 默认 7维快照
}
function attribSwitch(v) {
  document.querySelectorAll('#attrib-tabs .dn-tab').forEach((t) => t.classList.toggle('active', t.dataset.v === v));
  if (v === 'snap') renderSnap(currentAttribScenario);
  else if (v === 'thinking') loadAttribThinking(currentAttribScenario);
  else if (v === 'loop') renderAttribLoop(currentAttribScenario);
}
// 复用既有 snapHtml + withAttr 逻辑：把原 drillGateAttribution 的 fetch+渲染抽到 renderSnap
async function renderSnap(scenarioId) {
  const body = document.getElementById('attrib-modal-body');
  if (!scenarioId) { body.innerHTML = '<div class="dn-empty">未选择场景</div>'; return; }
  try {
    const r = await fetch(`/api/monitor/decisions?scenario_id=${encodeURIComponent(scenarioId)}&limit=50`);
    const { items } = await r.json();
    const withAttr = (items || []).filter((d) => d.attribution);
    if (!withAttr.length) { body.innerHTML = `<h3 style="margin:0 0 8px">${scenarioId} · 单次决策 7 维输入快照</h3><div class="dn-empty">该闸门暂无带 attribution 的决策</div>`; return; }
    body.innerHTML = `<h3 style="margin:0 0 8px">${scenarioId} · 单次决策 7 维输入快照</h3>` + withAttr.map((d) => snapHtml(d, [])).join('');
  } catch (e) { body.innerHTML = '<div class="dn-empty">加载失败：' + _esc(e.message) + '</div>'; }
}
async function loadAttribThinking(scenarioId) {
  const body = document.getElementById('attrib-modal-body');
  body.innerHTML = '加载思维要素…';
  try {
    const r = await fetch(`/api/decision/pre-context?scenario_id=${encodeURIComponent(scenarioId)}`);
    if (r.status === 401) { body.innerHTML = '<div class="dn-empty">请先登录</div>'; return; }
    const j = await r.json();
    if (!j.ok) { body.innerHTML = '<div class="dn-empty">加载失败</div>'; return; }
    if (j.generic) body.innerHTML = '<div class="dn-warn">该场景未配置思维模板，显示通用八要素骨架</div>';
    body.innerHTML += (j.thinking_skeleton || []).map((e) => `
      <div class="card sdim-card">
        <div class="sdim-head">${_esc(e.label)} ${e.focus ? '<span class="sdim focus">聚焦×1.5</span>' : ''}</div>
        <div class="sdim-q">${_esc(e.guiding_question)}</div>
        <div class="sdim-prompts">${(e.prompts||[]).map((p)=>`<div>• ${_esc(p)}</div>`).join('')}</div>
        <div class="sdim-rulers">${(e.ruler_keys||[]).map((k)=>`<span class="sdim neutral">尺·${_esc(k)}</span>`).join('')} ${(e.methodology||[]).map((m)=>`<span class="sdim neutral">${_esc(m)}</span>`).join('')}</div>
        ${e.example ? `<div class="sdim-ex">例：${_esc(e.example)}</div>` : ''}
      </div>`).join('');
  } catch (e) { body.innerHTML = '<div class="dn-empty">加载失败：' + _esc(e.message) + '</div>'; }
}
function renderAttribLoop(scenarioId) {
  const body = document.getElementById('attrib-modal-body');
  body.innerHTML = `<h3>闭环写回（C1/C2/C3）</h3>
    <div class="dn-empty">写回入口：复盘 / 记忆影响 / 后见之明基线。需登录，写经既有 POST 端点落库。</div>
    <textarea id="loop-retro" placeholder="A事实 / B假设 / C推论 / G目标" style="width:100%;min-height:80px"></textarea>
    <button class="snap-write-btn" onclick="attribRetro('${_esc(scenarioId)}')">提交复盘(C1)</button>
    <div id="loop-msg" class="dn-empty"></div>`;
}
async function attribRetro(scenarioId) {
  const msg = document.getElementById('loop-msg');
  try {
    const r = await fetch(`/api/decision/${encodeURIComponent(scenarioId)}/retro`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: document.getElementById('loop-retro').value }) });
    if (r.status === 401) { msg.textContent = '请先登录'; return; }
    const j = await r.json();
    msg.textContent = j.ok ? '已落库（provenance/记忆）' : ('失败：' + (j.error||''));
  } catch (e) { msg.textContent = '失败：' + e.message; }
}
```

> 注意：原 `snapHtml` 使用 `outcomesMap` 参数；抽离后 `renderSnap` 调 `snapHtml(d, [])` 省略业务结果（保持原"无业务结果"态，写回入口在 loop 页签）。若需保留补录按钮，可保留 `snapHtml` 原签名。

- [ ] **Step 5: 色值合规（零硬编码）**

新增 CSS 类（在页面 `<style>` 内）复用 tokens 变量，不写 `#xxx`：

```css
.dn-warn { color: var(--warn); background: var(--panel); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font-size:12px; margin-bottom:8px; }
.sdim-card { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; background:var(--panel); }
.sdim-head { font-weight:600; font-size:13px; color:var(--ink); }
.sdim-q { font-size:12px; color:var(--mut); margin:4px 0; }
.sdim-prompts { font-size:12px; color:var(--ink); }
.sdim-rulers { margin-top:4px; }
.sdim-ex { font-size:11px; color:var(--mut); margin-top:4px; }
.cl-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:12px; }
.cl-card .cl-body { font-size:12px; color:var(--mut); margin-top:8px; }
.cl-row { padding:3px 0; border-bottom:1px solid var(--line); }
```

- [ ] **Step 6: 浏览器验证（登录态）**

Run: 启动 `npm run dev`，浏览器登录后访问 `http://localhost:3000/sales-decision-monitor`：
- #closure-loop 三卡显"暂无数据/暂无采样"（真实，因 P2/P3 表为 0 行）
- 点决策下钻弹窗 → 「思维要素」页签显示 8 要素 + 九尺子徽标；「闭环写回」页签可提交复盘
- 未登录访问端点显 401、前端显"请先登录"

- [ ] **Step 7: Commit**

```bash
cd D:/system/CRM-ai-native
git add src/web/sales-decision-monitor.html
git commit -m "feat(P0-②+P2/P3): 监控台接入闭环看板 + 弹窗思维要素/闭环页签

Co-Authored-By: 王川 <watchm@163.com>"
```

---

## Task G: config 中心接入思维要素 + Skill 作用域

**Files:**
- Modify: `src/portal/configCenter.js`（id:33）
- Create: `src/web/decision-thinking.html`
- Modify: `src/web/config.html`（#skill-scope section）

### G.1 configCenter.js 加 id:33

- [ ] **Step 1: 在 CONFIG_ITEMS 数组（第 36 行后）追加**

```js
  { id: 33, name: '销售决策思维要素（8要素×九尺子）', group: '销售方法论与决策治理', status: 'ready', page: '/decision-thinking.html', endpoint: '/api/decision/thinking-templates', note: '8 大决策各自八要素提问×九尺子评分键总览（方法论层，代码版化，只读）' },
```

- [ ] **Step 2: 在 config.html GROUPS 的 G2 items 追加 33**

`src/web/config.html` 第 68 行 G2：`items: [14, 15, 16, 26, 31, 32, 35]` → 追加 `, 33`。

### G.2 新建 decision-thinking.html

- [ ] **Step 3: 创建页面（复用 layout/components/tokens）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>销售决策思维要素 · 8要素×九尺子</title>
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<style>
  body { font-family: var(--font); margin:0; background: var(--bg); color: var(--ink); }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 18px; }
  .sub { color: var(--mut); font-size: 13px; margin-bottom: 12px; }
  .scn { border:1px solid var(--line); border-radius: var(--radius-lg); padding:12px 14px; margin-bottom:14px; background: var(--panel); }
  .scn h2 { font-size:15px; border-left:4px solid var(--ac); padding-left:8px; margin:0 0 8px; }
  .scn .note { color: var(--mut); font-size:12px; margin-bottom:8px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; }
  th { background: var(--panel); color: var(--mut); }
  .generic { color: var(--warn); }
  .rulers span, .methods span { display:inline-block; margin:0 3px 3px 0; padding:1px 6px; border:1px solid var(--line); border-radius:10px; font-size:11px; color: var(--mut); }
  #err { color: var(--err); }
</style>
<script type="module" src="/portal/components.js"></script>
</head>
<body>
<header class="page-head"><div class="ph-main"><h1 class="page-title">销售决策思维要素 · 8要素×九尺子</h1></div></header>
<div class="wrap">
  <div class="sub">8 大销售决策各自的八要素提问 × 九尺子评分键（方法论层，代码版化自 thinkingTemplates.js，只读）</div>
  <div id="err"></div>
  <div id="list">加载中…</div>
</div>
<script type="module">
  import { injectLayout } from '/portal/layout.js';
  import { me } from '/portal/api.js';
  injectLayout();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  async function load() {
    try {
      const r = await me();
      if (r?.role == null) { document.getElementById('list').innerHTML = '<div class="generic">请先登录</div>'; return; }
    } catch { document.getElementById('list').innerHTML = '<div class="generic">请先登录</div>'; return; }
    try {
      const r = await fetch('/api/decision/thinking-templates');
      if (r.status === 401) { document.getElementById('list').innerHTML = '<div class="generic">请先登录</div>'; return; }
      const j = await r.json();
      if (!j.ok) { document.getElementById('err').textContent = '加载失败'; return; }
      document.getElementById('list').innerHTML = j.items.map((it) => `
        <div class="scn">
          <h2>${esc(it.stage)} · ${esc(it.scenario_id)} ${it.generic ? '<span class="generic">（未配置思维模板）</span>' : ''}</h2>
          <div class="note">${esc(it.scenario_note)}</div>
          <table><thead><tr><th>要素</th><th>核心问题</th><th>九尺子评分键</th><th>方法</th></tr></thead>
          <tbody>${(it.elements||[]).map((e) => `<tr>
            <td><b>${esc(e.label)}</b>${e.focus ? ' <span class="generic">聚焦</span>' : ''}</td>
            <td>${esc(e.guiding_question)}</td>
            <td class="rulers">${(e.ruler_keys||[]).map((k)=>`<span>尺·${esc(k)}</span>`).join('')}</td>
            <td class="methods">${(e.methodology||[]).map((m)=>`<span>${esc(m)}</span>`).join('')}</td>
          </tr>`).join('')}</tbody></table>
        </div>`).join('');
    } catch (e) { document.getElementById('err').textContent = '加载失败：' + e.message; }
  }
  load();
</script>
</body>
</html>
```

### G.3 config.html 追加 #skill-scope section

- [ ] **Step 4: 在 config.html render() 末尾（第 99 行 `panelsEl.appendChild(panel);` 之后）追加动态 section**

在 `render()` 函数内、`panelsEl.appendChild(panel);` 后追加：

```js
    // P3 D2 Skill 三层作用域（接 GET /api/skill/scope；不进 configCenter 卡片网格，独立 section）
    const skillSec = document.createElement('section');
    skillSec.className = 'cfg-group on';
    skillSec.id = 'skill-scope';
    skillSec.innerHTML = `<h3>Skill 三层作用域（system / workspace / user）</h3>
      <h4>生效层按 user &gt; workspace &gt; system 归并；推广到 workspace 需登录写经 HITL</h4>
      <div id="skill-scope-grid" class="cfg-grid"><div class="dn-empty">加载中…</div></div>`;
    panelsEl.appendChild(skillSec);
    loadSkillScope();
```

并在 `render()` 后定义 `loadSkillScope`：

```js
  async function loadSkillScope() {
    const grid = document.getElementById('skill-scope-grid');
    if (!grid) return;
    try {
      const r = await fetch('/api/skill/scope');
      if (r.status === 401) { grid.innerHTML = '<div class="dn-empty">请先登录</div>'; return; }
      const j = await r.json();
      const rows = (j && j.skills) || [];
      if (!rows.length) { grid.innerHTML = '<div class="dn-empty">暂无作用域记录，可在某 skill 试跑后推广</div>'; return; }
      grid.innerHTML = `<table class="dn-table"><thead><tr><th>技能</th><th>生效层</th><th>启用</th><th>溯源</th><th>操作</th></tr></thead><tbody>`
        + rows.map((s) => `<tr>
          <td><code>${esc(s.skill)}</code></td>
          <td><span class="sdim neutral">${esc(s.scope_level)}</span></td>
          <td>${s.enabled ? '✓' : '—'}</td>
          <td>${esc(s.promoted_from || '—')}</td>
          <td>${s.scope_level === 'system' ? `<button class="snap-write-btn" onclick="promoteSkillScope('${esc(s.skill)}')">推广到 workspace</button>` : '—'}</td>
        </tr>`).join('') + '</tbody></table>';
    } catch (e) { grid.innerHTML = '<div class="dn-empty">加载失败：' + esc(e.message) + '</div>'; }
  }
  window.promoteSkillScope = async (skill) => {
    const note = prompt('推广备注（可选）：') || null;
    const r = await fetch('/api/skill/scope/promote', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ skill, to:'workspace', note }) });
    if (r.ok) { loadSkillScope(); } else { alert('推广失败：' + (await r.json()).error); }
  };
```

> 注：现有 `/api/skill/scope` 返回归并后的生效集合（每 skill 一行，含 `scope_level/enabled/promoted_from`），故表格以"生效层"呈现三层归并结果，不另造 system/workspace/user 三列（遵守"接已有 API 不新增端点"铁律；如需三维原始态列为后续增强）。

- [ ] **Step 5: 审计零硬编码色值**

Run: `cd D:/system/CRM-ai-native && C:/Users/wangchuan08/.workbuddy/binaries/python/envs/default/bin/python tmp/audit_css_vars.py src/web/decision-thinking.html src/web/config.html src/web/sales-decision-monitor.html`
Expected: 0 违规。

- [ ] **Step 6: 浏览器验证**

- `http://localhost:3000/config.html`：G2 组出现「销售决策思维要素」卡片 → 进 `/decision-thinking.html` 列出 8 大决策 8 要素×九尺子；底部 #skill-scope 显 system 层种子（Task E 后）。
- 未登录显"请先登录"。

- [ ] **Step 7: Commit**

```bash
cd D:/system/CRM-ai-native
git add src/portal/configCenter.js src/web/decision-thinking.html src/web/config.html
git commit -m "feat(P0-②+P3): config 中心接入思维要素总览 + Skill 三层作用域 UI

Co-Authored-By: 王川 <watchm@163.com>"
```

---

## 验收（合并）

1. `node test/decision/thinkingTemplate.test.js` + `thinkingTemplatesApi.test.js` 全绿；8 场景均 8 要素。
2. `GET /api/decision/thinking-templates` 登录返 8 items（含 7 新增作者化）；未登录 401。
3. 监控台 #closure-loop 三卡消费真实端点（空显"暂无"）；弹窗「思维要素」页签显 8 要素+九尺子；「闭环写回」可提交复盘。
4. `config.html` G2 出现 id:33 卡片 → `/decision-thinking.html` 列 8 大决策；底部 #skill-scope 显 system 种子 + 推广按钮。
5. `tmp/audit_css_vars.py` 三页零硬编码色值违规。
6. `npm test` 全量 62 例不回退（无回归）。

## 风险

- 弹窗改造涉及两设计文档共用 `attrib-modal`，已合并为单一 Task F 避免冲突。
- skill/scope 端点返回归并集合（非三维原始），表格以"生效层"呈现（诚实、不造假、不新增端点）。
- 概念覆盖卡依赖页面存在场景选择器 `#scenario-filter`；若无则固定首场景（实施时按 DOM 调整，保持空策略）。
