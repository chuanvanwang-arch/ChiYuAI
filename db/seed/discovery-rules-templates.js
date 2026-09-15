// db/seed/discovery-rules-templates.js
// §12.3 行业 discovery 配置单一事实源（7 行业）。
//
// 形状铁律（写错 = 静默丢弃，无异常无日志；见 test/config/industryTemplateDiscovery.test.js ②）：
//   providers → 数组 [{ id, enabled }]（非数组被 mergeDiscoveryRules:52 的 Array.isArray 挡掉；
//               且仅**覆盖既有 id**，不增删条数 ⇒ 无法借此越权新增付费源）
//   icp       → 键名仅 industries / min_headcount(number) / geo(array) / min_confidence
//   signals   → 每项 { weight: <number> }（直接写数字会覆盖掉对象 ⇒ 消费方 .weight === undefined）
//   playbooks → 对象数组，每项必含 name（orchestrationCompiler.js:13 compilePlaybook 无名即 throw）
//
// 付费源铁律（D1）：模板**不得声明**付费源（连名字都不出现）；系统候选（scope='system-candidate'）
//   按行业清单置 enabled:true；系统级默认（email-verify / web-research / tender / gaode）无需声明。
//
// 本模块**零 DB import** ⇒ 单测可纯函数校验，无 PG 耦合、无 flaky。
export const DISCOVERY_RULES_BY_INDUSTRY = Object.freeze({
  chemical: {
    providers: [{ id: 'attio', enabled: true }, { id: 'zhizao', enabled: true }],
    icp: { industries: ['chemical'], min_headcount: 200, geo: ['CN'] },
    signals: { tender_match: { weight: 0.95 }, funding_round: { weight: 0.5 } },
    playbooks: [
      { name: 'tender-first', match: 'tender_match', data: ['tender', 'gaode'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
      { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
    ],
  },
  consult: {
    providers: [{ id: 'zhizao', enabled: true }],
    icp: { industries: ['consulting'], min_headcount: 50, geo: ['CN'] },
    signals: { hiring_icp_role: { weight: 0.85 } },
    playbooks: [
      { name: 'hiring-first', match: 'hiring_icp_role', data: ['web-research'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
      { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
    ],
  },
  consult2: {
    providers: [],
    icp: { industries: ['consulting'], min_headcount: 20, geo: ['CN'] },
    signals: { website_redesign: { weight: 0.7 } },
    playbooks: [{ name: 'default', match: '', data: ['web-research'], ai: [], action: [] }],
  },
  demo: {
    providers: [],
    icp: { industries: ['b2b'], min_headcount: 10, geo: ['CN'] },
    signals: {},
    playbooks: [],
  },
  insmedi: {
    providers: [{ id: 'zhizao', enabled: true }],
    icp: { industries: ['medical_device'], min_headcount: 100, geo: ['CN'] },
    signals: { tender_match: { weight: 0.9 } },
    playbooks: [
      { name: 'tender-first', match: 'tender_match', data: ['tender', 'gaode'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
      { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
    ],
  },
  meddev: {
    providers: [{ id: 'attio', enabled: true }],
    icp: { industries: ['medical_device'], min_headcount: 150, geo: ['CN'] },
    signals: { funding_round: { weight: 0.8 } },
    playbooks: [
      { name: 'funding-first', match: 'funding_round', data: ['web-research', 'gaode'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
      { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
    ],
  },
  training: {
    providers: [],
    icp: { industries: ['training'], min_headcount: 20, geo: ['CN'] },
    signals: { hiring_icp_role: { weight: 0.8 }, website_redesign: { weight: 0.5 } },
    playbooks: [{ name: 'default', match: '', data: ['web-research'], ai: [], action: [] }],
  },
});
