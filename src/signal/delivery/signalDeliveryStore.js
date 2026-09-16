// src/signal/delivery/signalDeliveryStore.js — crm.signal_delivery 投递流水（防假绿核心）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.4（投递流水）
// 核心立场：send 被调用 ≠ 已送达；每条投递意图落流水（sent/failed/skipped），失败可追踪
import { randomUUID } from 'node:crypto';

export function createDeliveryStore(pool) {
  async function record({ signal_id, tenant_id = 'system', channel, provider = null, recipient = null, status = 'pending', last_error = null, provider_msg_id = null }) {
    const delivery_id = randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO crm.signal_delivery
        (delivery_id, signal_id, tenant_id, channel, provider, recipient, status, attempts, last_error, provider_msg_id, delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,CASE WHEN $7 IN ('sent') THEN now() ELSE NULL END)
       RETURNING *`,
      [delivery_id, signal_id, tenant_id, channel, provider, recipient, status, last_error, provider_msg_id],
    );
    return rows[0];
  }

  async function listBySignal(signal_id) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.signal_delivery WHERE signal_id=$1 ORDER BY created_at DESC`,
      [signal_id],
    );
    return rows;
  }

  async function failures({ tenant_id = 'system', since_hours = 24 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.signal_delivery
       WHERE tenant_id=$1 AND status IN ('failed','skipped') AND created_at > now() - make_interval(hours => $2)
       ORDER BY created_at DESC`,
      [tenant_id, since_hours],
    );
    return rows;
  }

  return { record, listBySignal, failures };
}
