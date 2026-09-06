// src/decision/auditabilitySla.js — 可审计性 SLA 物化（定时快照进 crm.agent_sla）
// 设计：docs/2026-08-31-auditability-sla-materialization-design.md（§5 表结构 / §6 物化 / §7 定时接入）
// 单一事实源：aggregateAuditability（auditability.js）——实时端点与物化共用，评分口径永不漂移。
// 写入通道：queryWrite（写池），agent_sla 是派生事实表（非粒子/决策/记忆，不触决策第 0 闸与「禁 DELETE」铁律；
//           90d 软轮转为事实表自身轮转，允许 DELETE）。
import { aggregateAuditability } from './auditability.js';
import { queryWrite } from '../db.js';

// 平台级可审计性 SLA 快照：aggregate 一次 → INSERT 一行（含各问三态计数 + raw_json 全量聚合）→ 90d 软轮转
// 返回聚合结果（调用方（定时器⑦/手动）可据此 emit trace/alert）
export async function materializeAuditabilitySla({ limit = 50, retentionDays = 90 } = {}) {
  const agg = await aggregateAuditability({ limit });          // 单一事实源
  // 空窗口兜底：agent_sla.auditability_pct NOT NULL，而聚合空窗口 pct=null（合法语义，端点同）——
  // 物化侧转 0 落库（raw_json 保留原 null，语义不丢失；对齐「空窗口不报错」设计）
  const pct = agg.auditability_pct ?? 0;
  await queryWrite(
    `INSERT INTO crm.agent_sla
       (measured_at, window_size, auditability_pct, full_count, with_conflict_count, tampered_count,
        q1_pass,q1_warn,q1_fail, q2_pass,q2_warn,q2_fail, q3_pass,q3_warn,q3_fail, q4_pass,q4_warn,q4_fail, raw_json)
     VALUES (now(), $1,$2,$3,$4,$5, $6,$7,$8, $9,$10,$11, $12,$13,$14, $15,$16,$17, $18)`,
    [agg.window, pct, agg.full, agg.with_conflict, agg.tampered,
     agg.per_status.Q1.pass, agg.per_status.Q1.warn, agg.per_status.Q1.fail,
     agg.per_status.Q2.pass, agg.per_status.Q2.warn, agg.per_status.Q2.fail,
     agg.per_status.Q3.pass, agg.per_status.Q3.warn, agg.per_status.Q3.fail,
     agg.per_status.Q4.pass, agg.per_status.Q4.warn, agg.per_status.Q4.fail,
     JSON.stringify(agg)]
  );
  if (retentionDays > 0) {
    await queryWrite(`DELETE FROM crm.agent_sla WHERE measured_at < now() - make_interval(days=>$1)`, [retentionDays]);
  }
  return agg;
}