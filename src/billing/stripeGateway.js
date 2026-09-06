// src/billing/stripeGateway.js — Stripe 适配器（Checkout Session + webhook 验签；fetch 直调 REST，零新增依赖）
// 凭据来自 config_store['billing-settings'].stripe（secret_key / webhook_secret / success_url / cancel_url）
// 本期用 sk_test 测试模式驱动验证；生产凭据配置化，上线前需境外主体资质或适配器兜底
import { readConfig } from '../config/configStore.js';
import { createSubscription, renewSubscription, upgradeSubscription } from './subscriptionService.js';

const API = 'https://api.stripe.com/v1';

async function stripeSettings() {
  const row = await readConfig('billing-settings', { tenantId: 'system' });
  return row?.value?.stripe || {};
}

// 构造 Checkout Session（mode='create'|'renew'|'upgrade'，metadata 携带租户/档位/模式）
export async function buildCheckoutSession(planId, cycle, tenantId, mode, { successUrl, cancelUrl } = {}) {
  const s = await stripeSettings();
  const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
  const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
  const plan = plans.find((p) => p.plan_id === planId);
  const amount = Math.round((plan?.seat_unit_price || 0) * 100); // CNY 分
  const months = cycle === 'quarterly' ? 3 : 1;
  const body = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'cny',
    'line_items[0][price_data][product_data][name]': `${plan?.name || planId} ${cycle}`,
    'line_items[0][price_data][unit_amount]': String(amount * months),
    'line_items[0][quantity]': '1',
    'metadata[tenant_id]': tenantId,
    'metadata[plan_id]': planId,
    'metadata[mode]': mode,
    success_url: successUrl || s.success_url || 'http://localhost:3000/billing.html',
    cancel_url: cancelUrl || s.cancel_url || 'http://localhost:3000/billing.html',
  });
  const r = await fetch(`${API}/checkout/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`stripe error ${r.status}: ${await r.text()}`);
  return r.json();
}

// webhook 验签（Stripe-Signature 的 HMAC-SHA256；无密钥/验签失败返回 false）
export async function verifyWebhook(payload, signature, secret) {
  if (!secret) return false;
  try {
    const crypto = await import('node:crypto');
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch { return false; }
}

// 缴费成功 → 状态机（续费=延长；升级=切档；创建=开新订阅）
export async function handleCheckoutCompleted(session) {
  const { tenant_id, plan_id, mode } = session.metadata || {};
  if (!tenant_id || !plan_id) return { ok: false, error: 'missing metadata' };
  const cycle = 'monthly';
  if (mode === 'renew') await renewSubscription(tenant_id, plan_id, cycle);
  else if (mode === 'upgrade') await upgradeSubscription(tenant_id, plan_id, cycle);
  else await createSubscription(tenant_id, plan_id, cycle);
  return { ok: true };
}
