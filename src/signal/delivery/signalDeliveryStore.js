// src/signal/delivery/signalDeliveryStore.js — crm.signal_delivery 投递流水（防假绿核心）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.4（投递流水）
// 核心立场：send 被调用 ≠ 已送达；每条投递意图落流水（sent/failed/skipped），失败可追踪
//
// ── F-6(b)（2026-09-16 实测修正）：**幂等键**——“同 (signal_id, channel) 只有一行台账” ──
// 原实现：`delivery_id = randomUUID()` 且 `attempts` 硬写 1 ⇒ **每次调用都插新行**。
//   后果（真实库实测，非推演）：`crm.signal_delivery` 中 `email skipped` 随每一轮泵**线性增长**
//   —— sim-erp `935 → 1125`（+190 = 2 轮泵 × 95 条 signal，两次独立测量一致）；全库实况
//   `system` 1603 / `acme-demo` 1591 / `sim-erp` 1505 行，而 `max(attempts)` 全为 **1**
//   ⇒ 本表的 `attempts` 列从未被使用过（原设计的累加语义根本没落地）。
//   双重后果：① 运行态表无界增长；② 判据 A 的「该渠道有没有行」分母被**表自身的噪音**永久填满
//   ⇒ 任何**真实静默**再也不可检出（「自指仪器」族缺陷）。
// 修正：`delivery_id` 改为**确定性键** `deliveryKey(signal_id, channel)` + `ON CONFLICT DO UPDATE`
//   状态就地推进、`attempts` 累加。取舍说明（刻意为之）：本表是**运行态**台账（投递当前状态），
//   不是审计流水——审计链在 `crm.decision` / `crm.events`。收敛为一行后不再保留每次尝试的
//   独立行，但 `attempts` 计数 + `last_error` 保留了「试过几次、最后为何没成功」。
//   ⚠ 与本文件配套的**成对改动**（不得只改一侧）：`src/signal/dispatcher.js` 的 `attemptCount`
//   必须由 `COUNT(*)` 改为读 `attempts`——合并键后 `COUNT(*)` 恒为 1，会让 retry 上限永不触发
//   ⇒ 退化为无限重投。

// 确定性投递键。signal_id 在 crm.signal 中为主键（`ON CONFLICT (signal_id)`，见 src/signal/store.js）
//   ⇒ 全局唯一，故 (signal_id, channel) 足以定位一条投递台账，无需并入 tenant_id。
export function deliveryKey(signal_id, channel) {
  return `${signal_id}::${channel}`;
}

export function createDeliveryStore(pool) {
  async function record({ signal_id, tenant_id = 'system', channel, provider = null, recipient = null, status = 'pending', last_error = null, provider_msg_id = null }) {
    const delivery_id = deliveryKey(signal_id, channel);
    const { rows } = await pool.query(
      `INSERT INTO crm.signal_delivery
        (delivery_id, signal_id, tenant_id, channel, provider, recipient, status, attempts, last_error, provider_msg_id, delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,CASE WHEN $7 IN ('sent') THEN now() ELSE NULL END)
       ON CONFLICT (delivery_id) DO UPDATE SET
         status          = EXCLUDED.status,
         attempts        = signal_delivery.attempts + 1,
         provider        = COALESCE(EXCLUDED.provider, signal_delivery.provider),
         recipient       = COALESCE(EXCLUDED.recipient, signal_delivery.recipient),
         last_error      = EXCLUDED.last_error,
         provider_msg_id = COALESCE(EXCLUDED.provider_msg_id, signal_delivery.provider_msg_id),
         -- 送达时间**只前进不抹除**：sent 时取「首次送达时间」（重复 sent 不退后），
         --   非 sent 时保留历史值（曾送达过是事实，不因后续一条 skipped 而消失）。
         delivered_at    = CASE WHEN EXCLUDED.status = 'sent'
                                THEN COALESCE(signal_delivery.delivered_at, EXCLUDED.delivered_at)
                                ELSE signal_delivery.delivered_at END
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
