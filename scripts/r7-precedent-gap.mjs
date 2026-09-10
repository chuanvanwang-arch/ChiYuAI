// scripts/r7-precedent-gap.mjs
// R7-T1：量化 HUMAN 态决策占比（先例池覆盖度缺口观测）。只读，不写库。
// 注意：confirmDecision 仅 emit('decision','confirmed')，不写 decision_event('confirmed')，
//       故「确认事件数」不可作为确认率代理；本脚本改以「终态占比」作粗略代理并明确标注。
// 用法：node scripts/r7-precedent-gap.mjs            （默认库，生产 crm_native）
//       PGDATABASE=crm_native_test node scripts/r7-precedent-gap.mjs
import { query } from '../src/db.js';

const r = await query(`
  SELECT state, count(*)::int n
  FROM crm.decision
  GROUP BY state ORDER BY n DESC
`);
const total = r.rows.reduce((s, x) => s + x.n, 0);
const byState = Object.fromEntries(r.rows.map((x) => [x.state, x.n]));
const human = byState['HUMAN'] || 0;
const humanShare = total ? ((human / total) * 100).toFixed(2) : '0.00';
// 终态（已闭环）代理：CONFIRMED + AUTONOMOUS + REVERSED
const resolved = (byState['CONFIRMED'] || 0) + (byState['AUTONOMOUS'] || 0) + (byState['REVERSED'] || 0);
const resolvedRate = total ? ((resolved / total) * 100).toFixed(2) : '0.00';
// 缺口阈值（设计 §4）：HUMAN 占比 > 10% 视为显著，触发 B/C 方案独立评估（不在本计划范围）
const GAP_THRESHOLD = 10;
const significant = Number(humanShare) > GAP_THRESHOLD;

const report = `# R7 先例自锁 — HUMAN 缺口量化报告
生成时间: ${new Date().toISOString()}
目标库: ${process.env.PGDATABASE || 'crm_native(默认/生产)'}

## 决策状态分布（crm.decision）
${r.rows.map((x) => `- ${x.state}: ${x.n}`).join('\n')}
- 总计: ${total}

## 覆盖度缺口
- HUMAN 态决策数: ${human}
- HUMAN 占比: ${humanShare}%   （显著阈值 > ${GAP_THRESHOLD}%）
- 终态占比(粗略代理 = (CONFIRMED+AUTONOMOUS+REVERSED)/total): ${resolvedRate}%
- 口径说明: confirmDecision 不写 decision_event('confirmed')，故不以「确认事件数」作确认率代理。

## 结论
${
  human === 0
    ? '当前无 HUMAN 态滞留决策，先例池未被未确认人工决策污染。'
    : `存在 ${human} 条 HUMAN 态滞留决策（占比 ${humanShare}%${significant ? '，已超显著阈值' : ''}）。` +
      (significant
        ? '按设计 §4，应单独立项评估方案 B/C（扩收 HUMAN 入池 / 新增 HUMAN_RESOLVED 态）；本计划（方案 A）仅做可观测+回归护栏，不改动语义。'
        : '未超显著阈值，维持方案 A 观测即可。')
}
`;
console.log(report);
