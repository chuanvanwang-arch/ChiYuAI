// src/action/auditHook.js — 审计单点钩子（10-ai-capability-audit §3.2 机制级强制：粒子写通道必经）
// 设计来源：docs/2026-08-25-10-ai-capability-audit.md V2（12 业务域全进审计）/ V3（价格+审批=审计事件流）/ V5（写钩子=写通道单点必经）
// 纪律：
//  - append-only（无 update/delete；表无 updated_at 列），擦除语义用 invalidated/archived 墓碑（对齐 decision_provenance 范式）
//  - SHA-256 链式校验和（previous_checksum 全链串联，防篡改可 verify）
//  - fail-open：审计写失败不阻断主写（对齐 alertHook「不阻塞主事务」；失败可观测）
// 引用方（写通道必经节点）：
//  - src/particles/particleRepo.js（createParticle / updateParticle / createEdge）
//  - src/action/executor.js（写 Action requested/executed/failed 三段）
//  - src/approval/compensation.js（审批回滚补偿）
//  - src/sales/priceCalc.js（价格变更留痕）
import { query, queryWrite } from '../db.js';
import { createHash } from 'crypto';

// SHA-256（审计链式校验和）
export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

// 幂等建表（对齐 10-doc §3.2 AuditEvent 数据结构：target_particle_type/source/action/actor/decision_id/payload + 链式校验和）
export async function ensureAuditSchema() {
  await queryWrite(`CREATE TABLE IF NOT EXISTS crm.audit_event (
    id BIGSERIAL PRIMARY KEY,
    target_particle_type text NOT NULL,      -- LEAD→ORDER 12 业务域 + approval/price 治理域
    source text NOT NULL,                    -- particle / action / external_skill / approval / price
    action text NOT NULL,                    -- 写动作名（create/update/submit/approve/rollback/price_change…）
    actor text DEFAULT 'system',             -- 执行者（人/Agent/自动）
    decision_id uuid,                        -- 写通道第 0 闸强制携带的决策 id（无决策不写 → 审计同源）
    payload jsonb,                           -- 当时全字段（含 price_change_reason / approval_instance_id）
    checksum text NOT NULL,                  -- SHA-256（previous_checksum + payload 规范串）
    previous_checksum text,                  -- 前一条校验和（链式防篡改）
    created_at timestamptz DEFAULT now()
  )`);
}

// 审计单点：写入一条审计事件（append-only）
// 调用方纪律：写通道必经节点调用；失败 fail-open（返回 {ok:false}，不 throw、不阻断主写）
export async function recordAudit({ target_particle_type, source, action, actor = 'system', decision_id = null, payload = {} }) {
  const prev = (await query(
    `SELECT checksum FROM crm.audit_event ORDER BY id DESC LIMIT 1`
  )).rows[0];
  const previous_checksum = prev ? prev.checksum : null;
  const canonical = JSON.stringify(payload ?? {});
  const checksum = sha256((previous_checksum || '') + '|' + canonical);
  try {
    await queryWrite(
      `INSERT INTO crm.audit_event (target_particle_type, source, action, actor, decision_id, payload, checksum, previous_checksum)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [target_particle_type, source, action, actor, decision_id, canonical, checksum, previous_checksum]
    );
    return { ok: true, id: null };
  } catch (e) {
    // fail-open：审计失败不阻断主写（可观测：trace 事件）
    return { ok: false, error: e.message };
  }
}

// 价格变更审计便利封装（V3：价格变更=审计事件流；调用方：quoteService/contractService 写时管线）
// priceCalc.js 保持纯逻辑（无 PG 依赖），此处是事件留痕落库点
export async function recordPriceChangeAudit({ particle_id, before, after, reason, actor = 'system', decision_id = null }) {
  return recordAudit({
    target_particle_type: 'CRM_PRICE_LIST',
    source: 'price',
    action: 'price_change',
    actor,
    decision_id,
    // field 键（P1③ 字段历史投影）：对外 `GET /api/particles/:id/field-history?field=list_price`
    payload: { particle_id, field: 'list_price', before, after, price_change_reason: reason || null },
  });
}

// 防篡改校验：重算整链，逐项比对（对齐 decision_provenance.verifyChain 语义）
export async function verifyAuditChain() {
  const rows = (await query(
    `SELECT id, payload, previous_checksum, checksum FROM crm.audit_event ORDER BY id`
  )).rows;
  let prev = null;
  for (const row of rows) {
    const expected = sha256((prev || '') + '|' + (row.payload ?? '{}'));
    if (expected !== row.checksum) return { status: 'TAMPERED', broken_at: row.id };
    prev = row.checksum;
  }
  return { status: 'OK', entries: rows.length };
}