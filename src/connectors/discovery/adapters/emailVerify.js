// src/connectors/discovery/adapters/emailVerify.js
// 只补「本体推断不出」的邮箱可信度。诚实原则：本地仅做语法 + 一次性域名判定（confidence 0.6），
// **不得伪称「已验证」**；真实验证 API 经 ctx.verifyEmail 注入（出厂不联网、零成本）。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const DEFAULT_DISPOSABLE_DOMAINS = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com'];

export function localEmailCheck(email, disposable = DEFAULT_DISPOSABLE_DOMAINS) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return { valid: false, reason: 'syntax' };
  const domain = e.split('@')[1];
  if (disposable.includes(domain)) return { valid: false, reason: 'disposable' };
  return { valid: true, reason: 'syntax-only', confidence: 0.6 };
}

export function emailVerify(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'email-verify', kind: 'email/phone', scope: 'system', costTier: 1,
              coverageFields: ['email', 'phone'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      if (!fields.includes('email')) return {};
      const email = entity?.email;
      if (!email) return {};
      const disposable = this.config.disposableDomains || DEFAULT_DISPOSABLE_DOMAINS;
      let check;
      try {
        check = typeof ctx.verifyEmail === 'function'
          ? await ctx.verifyEmail(email, ctx)                  // 真实验证 API（编排侧注入）
          : localEmailCheck(email, disposable);                // 出厂：纯本地、确定性、不联网
      } catch { return {}; }
      if (!check || !check.valid) return {};
      return fieldHit('email', { value: email, confidence: check.confidence ?? 0.6, cost: check.cost ?? 0, provider: this.id });
    }
  })();
}

registerProvider('email-verify', emailVerify);
