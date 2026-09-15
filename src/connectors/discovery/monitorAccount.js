// src/connectors/discovery/monitorAccount.js
// C3: 持续账户监控闭环（吸收 Clay Account Agent 持久记忆 + 持续刷新）。
// 信号到达 或 定时增量刷新 ->
//   lead-fit 重评分(复用九标尺+2D judge) -> 增量 append 账户 append-only 记忆 -> glass-box 输出。
// 铁律：禁 DELETE（只 append 记忆、只 update payload）；跨外联绝不自动发信（走 HITL，本模块零外发依赖）。
// 契约（DI）：ctx = { getAccount, rescore, appendMemory, updateParticle }，与 orchestrator deps 范式一致。
import { buildGlassBox } from '../../agent/glassBox.js';
import { evaluate } from '../../feedback/discoveryMetrics.js';

export async function monitorAccount(ctx, accountId, signals = []) {
  const acct = await ctx.getAccount(accountId);                 // 读既有账户（不新建）
  if (!acct) throw new Error(`账户不存在: ${accountId}`);
  const rescored = await ctx.rescore(accountId, { signals });   // lead-fit scenario 重跑（复用九标尺+2D judge）
  const score = rescored?.score;
  if (score == null) throw new Error('monitorAccount: rescore 未返回 score（拒绝静默置 0）');

  const gb = buildGlassBox({ score, ruleRef: rescored.ruleRef, signals });

  // 增量 append 到账户持久记忆（append-only，不覆盖、不删除）
  await ctx.appendMemory('CRM_ACCOUNT', accountId, { kind: 'rescore', ...gb, ts: new Date().toISOString() });

  // 只 update payload（且**读-改-写**：顶层浅合并会整体替换 payload.discovery，须展开既有子键）
  const prevDiscovery = acct.payload?.discovery && typeof acct.payload.discovery === 'object' ? acct.payload.discovery : {};
  await ctx.updateParticle(accountId, {
    patch: {
      discovery: {
        ...prevDiscovery,
        intent_score: { value: score, judge: gb.judge },
        why_narrative: gb.why_narrative,
      },
    },
  });

  // 喂 Task 12 feedback-loop（否则 discoveryMetrics 全仓零消费方 = 死码）；单账户本轮=1/1
  const fb = evaluate('monitorAccount_refresh_rate', 1);

  return { accountId, score, why_narrative: gb.why_narrative, glass_box: gb, feedback: { metric: 'monitorAccount_refresh_rate', value: 1, ...fb } };
}
