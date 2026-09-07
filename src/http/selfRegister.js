// src/http/selfRegister.js — 自助注册（公开端点，免 admin 闸）
// 设计：根据「公司名称」自动判定租户（归一化 slug 匹配）；租户不存在则自动建租户并播种差异化键。
// 安全：密码统一 pgcrypto crypt 哈希；首注册者=该租户 admin（公司开通人），已存在租户的新成员=sales（防越权）。
// 决策第0闸：注册记为 user_self_register 决策事件（bootstrap 引导路径，decision_id 空，对齐 seed 播种豁免）。
// 禁 DELETE / 禁 TRUNCATE：建租户只走 seedTenantDefaults（幂等 INSERT ... ON CONFLICT DO NOTHING）。
import { query, queryWrite } from '../db.js';
import { resolveSysadminRef } from '../rbac.js';
import { seedTenantDefaults } from '../../db/seed/tenantDefaults.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { issueActivation } from './activation.js'; // 注册→激活闭环：生成+送达激活码

// 六角色白名单（与 userManagement.js 对齐）
const ROLE_TAGS = ['sales', 'manager', 'presales', 'contract_admin', 'finance', 'admin', 'ten_admin'];

// 归一化公司名：去常见后缀 / 标点 / 空格，转小写 —— 用于「同一公司不同写法」判定同一租户
export function normalizeCompany(name = '') {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/[\s.,，。、()（）\-_/\\]+/g, '');
  const suffixes = [
    '股份有限公司', '有限责任公司', '有限公司', '股份公司', '责任公司',
    '信息技术有限公司', '网络科技有限公司', '科技有限公司', '科技公司',
    '集团', '公司', 'co.ltd', 'coltd', 'ltd', 'inc', 'llc', 'gmbh', 'corp', 'company', 'co',
  ];
  for (const suf of suffixes) {
    while (s.endsWith(suf) && s.length > suf.length) s = s.slice(0, -suf.length);
  }
  return s || 'unknown';
}

// 稳定 8 位 base36 哈希（FNV-1a）
function hash8(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

// 公司名 → 租户 ID（归一化后哈希，同一公司稳定命中同一租户）
export function companySlug(companyName) {
  return 'co-' + hash8(normalizeCompany(companyName));
}

// 根据公司名解析租户：存在且 active → 复用；不存在 → 自动建租户（带差异化播种）
export async function resolveTenantByCompany(companyName, createdBy) {
  const slug = companySlug(companyName);
  const ex = await query(`SELECT tenant_id, status FROM crm.tenants WHERE tenant_id=$1`, [slug]);
  if (ex.rows.length) {
    const t = ex.rows[0];
    if (t.status === 'active') return { tenantId: t.tenant_id, isNew: false };
    // 停用/退役租户不自动复活：以全名派生新 slug（碰撞概率可忽略）
    const slug2 = 'co-' + hash8(String(companyName || '').trim().toLowerCase() + ':alt');
    const ex2 = await query(`SELECT tenant_id FROM crm.tenants WHERE tenant_id=$1`, [slug2]);
    if (!ex2.rows.length) {
      await seedTenantDefaults(slug2, { all: true, createdBy }).catch(() => {});
      return { tenantId: slug2, isNew: true };
    }
    return { tenantId: slug2, isNew: false };
  }
  await seedTenantDefaults(slug, { all: true, createdBy }).catch(() => {});
  return { tenantId: slug, isNew: true };
}

function validateRegister(body = {}) {
  const errors = [];
  const n = {};
  if (!body.companyName || typeof body.companyName !== 'string' || body.companyName.trim().length < 2) {
    errors.push('companyName 必填（≥2 字）');
  } else n.companyName = body.companyName.trim();
  const email = body.email || body.username;
  if (!email || typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    errors.push('email 须为合法邮箱（将作为登录账号）');
  } else n.email = email.trim().toLowerCase();
  if (!body.displayName || typeof body.displayName !== 'string' || !body.displayName.trim()) {
    errors.push('displayName 必填');
  } else n.displayName = body.displayName.trim();
  if (!body.password || typeof body.password !== 'string' || body.password.length < 8) {
    errors.push('password 须为 ≥8 字字符串');
  } else n.password = body.password;
  // 手机（选填）：提供则走短信激活；否则走邮箱（username=邮箱）
  if (body.phone && typeof body.phone === 'string' && /^\d{6,}$/.test(body.phone.trim())) {
    n.phone = body.phone.trim();
  }
  // 推荐者（选填）：新租户未填默认 sysadmin；填写则须为 sysadmin 角色；存在租户加入可不填
  if (body.referrer && typeof body.referrer === 'string' && body.referrer.trim()) {
    n.referrer = body.referrer.trim();
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

// 核心：注册并（按需）开通租户
export async function registerUser(body = {}) {
  const v = validateRegister(body);
  if (!v.ok) return { ok: false, status: 400, error: v.errors.join('；') };
  const { companyName, email, displayName, password, referrer } = v.normalized;

  // 用户名（邮箱）全局唯一
  const dup = await query(`SELECT 1 FROM crm.crm_users WHERE username=$1`, [email]);
  if (dup.rows.length) return { ok: false, status: 409, error: '该邮箱已注册，请直接登录' };

  // 先判定是否新租户（按公司名归一化slug匹配 crm.tenants）
  const slug = companySlug(companyName);
  const ex = await query(`SELECT tenant_id, status FROM crm.tenants WHERE tenant_id=$1`, [slug]);
  const isNew = !ex.rows.length || (ex.rows[0].status !== 'active');

  // 新租户：推荐者选填（2026-09-07）：未填默认 sysadmin（平台托管责任推荐人）；填写则须为 sysadmin 角色
  let createdBy = null;
  if (isNew) {
    const referrerId = referrer || 'sysadmin';   // 选填默认：平台 sysadmin
    const ref = await resolveSysadminRef(referrerId);
    if (!ref) {
      return { ok: false, status: 400, error: `推荐者 ${referrerId} 不存在或不具备 sysadmin 角色` };
    }
    createdBy = { user_id: ref.user_id, username: ref.username };
  }

  // 解析租户（按公司名自动判定）；新租户播种时透传 createdBy
  const { tenantId } = await resolveTenantByCompany(companyName, createdBy);

  // D5修复：新租户首注册者=租户管理员(ten_admin，仅自有租户)；已有租户新成员=sales（防越权）
  const role = isNew ? 'ten_admin' : 'sales';

  // 席位闸：新租户首 admin 不拦（其本身是首个席位）；已有租户新增成员才拦
  if (!isNew) {
    const { checkSeatLimit } = await import('../billing/seatPolicy.js');
    const seat = await checkSeatLimit(tenantId);
    if (!seat.ok) return { ok: false, status: 402, error: seat.error };
  }

  // 密码哈希（pgcrypto blowfish，与既有写路径一致）
  const pw = (await query(`SELECT crypt($1, gen_salt('bf')) AS h`, [password])).rows[0].h;

  // 建用户（enabled=TRUE；activated=FALSE 强制激活前禁止登录；email 与 username 同值，支持用户名/邮箱双登录）
  const r = await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id, org_id, enabled, activated, email)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, FALSE, $7) RETURNING user_id`,
    [email, pw, role, displayName, tenantId, companyName, email]
  );

  // 写经决策第0闸（注册审计事件；bootstrap 引导路径 decision_id 空，对齐 seed 播种豁免）
  await recordDecisionEvent('user_self_register', {
    tenantId, companyName, email, role, isNewTenant: isNew, activated: false,
  }).catch(() => {});

  // 注册即未激活：生成 + 送达激活码（email/phone），不直发登录 token
  const channel = body.phone ? 'phone' : 'email';
  const target = body.phone || email;
  const act = await issueActivation({ username: email, channel, target })
    .catch((e) => ({ contact: target, devCode: undefined, _err: e.message }));

  return {
    ok: true, status: 201, requiresActivation: true,
    role, display_name: displayName, tenantId, isNewTenant: isNew,
    userId: r.rows[0]?.user_id || null,
    contact: act.contact, devCode: act.devCode,
  };
}

export async function handleRegister(req, res) {
  try {
    const r = await registerUser(req.body || {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.status(r.status).json({
      requiresActivation: r.requiresActivation || false,
      role: r.role, display_name: r.display_name,
      tenantId: r.tenantId, isNewTenant: r.isNewTenant,
      contact: r.contact, devCode: r.devCode,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}
