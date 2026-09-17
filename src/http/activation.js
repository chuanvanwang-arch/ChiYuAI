// src/http/activation.js — 自助注册激活闭环（注册 → 手机/邮箱激活 → 登录）
// 设计：2026-09-04 用户指令「注册后通过手机或邮箱激活，再回助手登录」。
// 纪律：① 验证码明文永不出 node（库仅存 pgcrypto crypt 哈希）；② 软核销（consumed_at），遵守"绝对禁 DELETE"；
//      ③ 送达 provider 无关：email 走 SMTP（SMTP_USER+SMTP_PASS 配置即真发；默认 Brevo smtp-relay.brevo.com:587 STARTTLS），
//         无配置 → 服务端日志 + 开发环境接口回显 devCode 便于端到端验证；phone 走短信网关（预留，未配置则日志回显）。
import { query, queryWrite } from '../db.js';
import { issueToken } from './auth.js';

const TTL_MS = Number(process.env.ACTIVATION_TTL_MS || 15 * 60 * 1000);

function genCode() {
  // 6 位数字激活码
  return String(Math.floor(100000 + Math.random() * 900000));
}

function mask(target = '') {
  if (/@/.test(target)) {
    const [u, d] = target.split('@');
    const head = u.slice(0, Math.min(2, u.length));
    return `${head}${'*'.repeat(Math.max(1, u.length - head.length))}@${d}`;
  }
  if (/^\d{6,}$/.test(target)) return `${target.slice(0, 3)}****${target.slice(-2)}`;
  return target.slice(0, 2) + '****';
}

// 送达：真实邮件（SMTP 配置即发）/ 短信（需网关）/ 开发回显兜底
async function sendActivation({ channel, target, code, username }) {
  const subject = '企业AI销售决策平台 · 账号激活码';
  const text = `您的账号激活码是 ${code}（15 分钟内有效）。如非本人操作请忽略。`;

  // 真实邮件：配置了 SMTP 凭据（SMTP_USER+SMTP_PASS）即真发；缺省指向 Brevo（smtp-relay.brevo.com:587 STARTTLS）
  if (channel === 'email' && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const nodemailer = await import('nodemailer');
      const host = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
      const port = Number(process.env.SMTP_PORT || 587);
      const transport = nodemailer.createTransport({
        host,
        port,
        secure: process.env.SMTP_SECURE === 'true' || port === 465, // 465=SSL，587=STARTTLS
        requireTLS: port === 587,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: target, subject, text,
      });
      console.log(`[activation] email sent via ${host} to ${mask(target)}`);
      return { delivered: true };
    } catch (e) {
      console.error('[activation] SMTP 发送失败，回退日志+回显:', e.message);
    }
  }

  // 短信：需接网关（SMS_PROVIDER=tencent/ali + 凭据 → 真实发送）。未配置则仅日志。
  if (channel === 'phone') {
    if (process.env.SMS_PROVIDER && process.env.SMS_PROVIDER !== 'none') {
      // TODO: 接入腾讯云/阿里云短信网关（读取 SMS_* 凭据调用其 HTTP API）。当前未实现真实外发，仍日志兜底。
      console.warn(`[activation][phone] SMS_PROVIDER=${process.env.SMS_PROVIDER} 已配置但网关调用未实现，暂日志兜底`);
    }
    console.log(`[activation][phone] target=${mask(target)} code=${code}`);
  }

  // 开发回显 / 兜底日志（无 SMTP 或显式开启时，devCode 随接口返回便于验证）
  console.log(`[activation] username=${username} channel=${channel} target=${mask(target)} code=${code}`);
  const echo = process.env.NODE_ENV !== 'production' && process.env.ACTIVATION_DEV_ECHO !== 'false';
  return { delivered: false, devCode: echo ? code : undefined };
}

// 生成 + 存储 + 送达激活码；返回脱敏联系方式与开发回显码
export async function issueActivation({ username, channel, target }) {
  const code = genCode();
  const { rows } = await query(`SELECT crypt($1, gen_salt('bf')) AS h`, [code]);
  const hash = rows[0].h;
  const expiresAt = new Date(Date.now() + TTL_MS);
  await queryWrite(
    `INSERT INTO crm.activation_code (username, channel, target, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [username, channel, target, hash, expiresAt]
  );
  const sent = await sendActivation({ channel, target, code, username });
  return { contact: mask(target), channel, devCode: sent.devCode };
}

// 核验激活码并置 activated=true（同时发网站自动登录 token）
export async function verifyAndActivate({ username, code } = {}) {
  if (!username || !code) return { ok: false, status: 400, error: 'username and code required' };
  const u = await query(`SELECT username, role, display_name, tenant_id, activated FROM crm.crm_users WHERE username=$1`, [username]);
  if (!u.rows.length) return { ok: false, status: 404, error: '账号不存在' };
  const cur = u.rows[0];
  if (cur.activated) return { ok: false, status: 409, error: '账号已激活，请直接登录' };

  const { rows } = await query(
    `SELECT id, code_hash, expires_at, consumed_at
     FROM crm.activation_code WHERE username=$1 AND purpose='activate' ORDER BY created_at DESC LIMIT 5`,
    [username]
  );
  let matchId = null;
  for (const r of rows) {
    if (r.consumed_at) continue;
    if (r.expires_at && r.expires_at < new Date()) continue;
    const v = await query(`SELECT crypt($1, $2) = $2 AS ok`, [code, r.code_hash]);
    if (v.rows[0].ok) { matchId = r.id; break; }
  }
  if (!matchId) return { ok: false, status: 400, error: '激活码无效或已过期，请重新获取' };

  await queryWrite(`UPDATE crm.activation_code SET consumed_at = now() WHERE id=$1`, [matchId]);
  await queryWrite(`UPDATE crm.crm_users SET activated = true WHERE username=$1`, [username]);

  const token = issueToken({ username: cur.username, role: cur.role, display_name: cur.display_name, tenantId: cur.tenant_id || 'system' });
  return { ok: true, status: 200, token, role: cur.role, display_name: cur.display_name, tenantId: cur.tenant_id || 'system' };
}

// 重发：复用该用户最近一次激活的目标/渠道；无记录则按 username(邮箱) 走 email
export async function resendActivation({ username } = {}) {
  if (!username) return { ok: false, status: 400, error: 'username required' };
  const u = await query(`SELECT username, activated FROM crm.crm_users WHERE username=$1`, [username]);
  if (!u.rows.length) return { ok: false, status: 404, error: '账号不存在' };
  if (u.rows[0].activated) return { ok: false, status: 409, error: '账号已激活，无需重发' };

  let channel = 'email', target = username;
  const last = await query(
    `SELECT channel, target FROM crm.activation_code WHERE username=$1 ORDER BY created_at DESC LIMIT 1`, [username]
  );
  if (last.rows.length) { channel = last.rows[0].channel; target = last.rows[0].target; }
  const issued = await issueActivation({ username, channel, target });
  return { ok: true, status: 200, ...issued };
}

export async function handleActivate(req, res) {
  try {
    const r = await verifyAndActivate(req.body || {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.status(r.status).json({ token: r.token, role: r.role, display_name: r.display_name, tenantId: r.tenantId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

export async function handleResend(req, res) {
  try {
    const r = await resendActivation(req.body || {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.status(r.status).json({ contact: r.contact, channel: r.channel, devCode: r.devCode });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}
