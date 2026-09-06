// src/sales/accountGuard.js — 账户归属守护（根因报告 §5 防复发）
// 目标：杜绝三类数据病——
//   ① 商机错绑无关账户（account_id 指向错误但存在的账户，如王总单错绑印通）
//   ② 不同客户并到同一账户（name 查重 / find-or-create）
//   ③ 无账户静默写（account_id 指向不存在的账户被 DB 静默接受）
// 设计：纯函数 + DB 辅助；用于 createParticle(CRM_DEAL) 与 importBatch(CRM_DEAL) 受治理写入口。
import { query } from '../db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AccountGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountGuardError';
    this.code = code;
  }
}

// 规范化客户名：去空格、转小写，用于近似查重（避免 "XX制造" vs "XX制造 " / "ABC Corp" vs "abc corp" 漏匹配）
export function normalizeAccountName(name) {
  return String(name == null ? '' : name).trim().replace(/\s+/g, '').toLowerCase();
}

// 名称一致性硬校验：deal.customer 与归属账户 name 明显不一致 → 抛错（防复用无关账户）
export function assertNameConsistent(account, customerName) {
  if (!account || !customerName) return;
  const an = normalizeAccountName(account?.payload?.name || account?.name);
  const cn = normalizeAccountName(customerName);
  if (an && cn && an !== cn) {
    throw new AccountGuardError(
      'ACCOUNT_NAME_MISMATCH',
      `商机 customer="${customerName}" 与归属账户 name="${account?.payload?.name || account?.name}" 不一致（疑似错绑，禁止复用无关账户）`
    );
  }
}

// 软外键：account_id 必须存在且为 CRM_ACCOUNT；缺失/非法 → 抛错（不静默接受）
export async function assertAccountExists(accountId, tenantId = 'system') {
  if (accountId == null || accountId === '') return null;
  if (!UUID_RE.test(String(accountId))) {
    throw new AccountGuardError('ACCOUNT_NOT_FOUND', `account_id=${accountId} 不是合法 UUID（禁止将商机绑到不存在的账户）`);
  }
  const r = await query(
    `SELECT id, payload FROM crm.particles WHERE tenant_id=$1 AND type='CRM_ACCOUNT' AND id=$2::uuid LIMIT 1`,
    [tenantId, String(accountId)]
  );
  if (r.rows.length === 0) {
    throw new AccountGuardError('ACCOUNT_NOT_FOUND', `account_id=${accountId} 指向的 CRM_ACCOUNT 不存在（禁止将商机绑到不存在的账户）`);
  }
  return r.rows[0];
}

// 按名查重：返回匹配账户（精确优先），用于 find-or-create 判定与防并户
export async function findAccountByName(name, tenantId = 'system') {
  const n = normalizeAccountName(name);
  if (!n) return null;
  const r = await query(
    `SELECT id, payload FROM crm.particles WHERE tenant_id=$1 AND type='CRM_ACCOUNT'
       AND (payload->>'name' ILIKE $2 OR replace(payload->>'name',' ','') ILIKE $3)
     ORDER BY created_at ASC LIMIT 5`,
    [tenantId, String(name), n]
  );
  if (!r.rows.length) return null;
  const exact = r.rows.find((x) => normalizeAccountName(x.payload?.name) === n);
  return exact || r.rows[0];
}

// find-or-create：按客户名解析归属账户，不存在则建独立账户（禁止复用无关账户 id）
export async function findOrCreateAccount({ name, owner, tenantId = 'system', industry }, actor) {
  const found = await findAccountByName(name, tenantId);
  if (found) return { account: found, created: false };
  const { createParticle } = await import('../particles/particleRepo.js');
  const effectiveOwner = owner && owner !== 'system' ? owner : (actor && actor !== 'system' ? actor : undefined);
  const a = await createParticle('CRM_ACCOUNT', {
    name: String(name).trim(),
    named_owner: effectiveOwner,
    named_state: 'active',
    industry: industry || undefined,
  }, { tenantId, actor: effectiveOwner || null, systemBypass: true });
  return { account: a, created: true };
}

// 商机账户归属解析（核心守卫，供 createParticle / importBatch 调用）：
//  - account_id 存在        → 校验存在 + 名称一致
//  - account_id 缺失 + customer 存在 → find-or-create（正确归属，杜绝无账户/错绑）
//  - 均无                  → 不强制（允许无归属草稿被后续流程补户）
export async function resolveDealAccount({ payload = {}, tenantId = 'system', actor = null } = {}) {
  const rawId = payload.account_id == null || payload.account_id === '' ? null : String(payload.account_id);
  const customer = payload.customer || payload.customer_name || null;
  if (rawId) {
    const acct = await assertAccountExists(rawId, tenantId);
    assertNameConsistent(acct, customer);
    return { account_id: rawId, status: 'bound', account: acct };
  }
  if (customer) {
    const { account, created } = await findOrCreateAccount(
      { name: customer, owner: payload.owner || payload.owner_id, tenantId, industry: payload.industry },
      actor
    );
    return { account_id: account.id, status: created ? 'created' : 'found', account };
  }
  return { account_id: null, status: 'none' };
}
