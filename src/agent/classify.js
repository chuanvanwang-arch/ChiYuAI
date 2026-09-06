// src/agent/classify.js — 需求文本 → 任务分诊（intent / level）
// 纯函数，供 POST /api/agent/dispatch 路由使用。无副作用、无 I/O，便于单测。
//
// 分诊优先级（复盘意图最优先，次之战略级，再次报价测算，最后跟进）：
//   retro    L2  含「复盘/回顾/总结教训/整改/处方/决策质量/根因分析」等复盘动作词（派发 decision-retro）
//   major    L3  含「重大/战略/千万/亿/集团/总部/上市」等战略级量级词
//   quote    L2  含「报价/测算/出方案/价格/单价」等商务动作词
//   followup L1  含「跟进/回访/关怀/催办/提醒」等日常动作词
// 过短（<4 字）或全不命中 → needsClarification 引导用户补全业务对象+动作。

const RULES = [
  // retro 置顶（D1 修复 2026-09-01）：复盘是明确动作意图，「复盘本月重大决策质量」同时命中「重大」量级词，
  // 若 major 在前会被误判为战略商机派给 quote-engine。
  { intent: 'retro', level: 'L2', re: /(复盘|回顾|总结教训|整改|处方|决策质量|根因分析)/ },
  { intent: 'major', level: 'L3', re: /(重大|战略|千万|亿|集团|总部|上市|独角兽)/ },
  { intent: 'quote', level: 'L2', re: /(报价|测算|出方案|方案|报价单|价格|单价|预算)/ },
  { intent: 'followup', level: 'L1', re: /(跟进|回访|关怀|催办|提醒|商机关怀|周报|月报)/ },
];

export function classifyRequirement(text) {
  const t = String(text || '').trim();
  if (t.length < 4) {
    return {
      intent: null,
      level: null,
      needsClarification: true,
      notes: ['指令过短，请补充业务对象与动作，例如：跟进本周逾期的三个商机'],
    };
  }
  for (const r of RULES) {
    if (r.re.test(t)) {
      return { intent: r.intent, level: r.level, needsClarification: false };
    }
  }
  return {
    intent: null,
    level: null,
    needsClarification: true,
    notes: [
      '未能识别任务类型。请包含业务动词（跟进 / 报价 / 测算）或量级词（重大 / 战略 / 千万）。',
      '示例：① 跟进本周逾期商机 ② 给蒙电 100 台做报价测算 ③ 拉起战略客户年度复盘',
    ],
  };
}

export default classifyRequirement;
