// src/connectors/discovery/credentialVault.js
// 凭据保险库：加密落库（pgcrypto at-rest）+ 运行时按租户解密注入 ctx.credentials。
// 绝不进前端、不进日志、不进 memory。deps 注入使得单测零 DB。
import { readConfig as storeRead, writeConfig as storeWrite } from '../../config/configStore.js';
// P0-1（2026-09-18）：接入形态单一事实源——用于判定「凭据是否归平台持有」。
//   用户侧形态（connector / local-bridge）凭据只在本机/对方平台，平台侧落库=违反「不保存密码」红线（ATTIO/ROX 同条）。
import { credentialsOnPlatform } from '../../channels/sourceKinds.js';

// 生产默认走 pgcrypto：pgp_sym_encrypt($1, $2) / pgp_sym_decrypt($1, $2)
// ⚠ pgcrypto 返回 bytea，node-pg 解析为 Buffer；直接存 JSON 会变成字节数组对象，
//    反向 pgp_sym_decrypt 拿到对象后静默失败（catch→null）。故用 base64 桥接：
//    encrypt: encode(pgp_sym_encrypt(...), 'base64') → 字符串；
//    decrypt: pgp_sym_decrypt(decode(... ,'base64'), ...) → 原始明文。
// 单测用 deps.pgpEncrypt/pgpDecrypt 注入（见 T2 测试），不受影响。
async function defaultPgpEncrypt(raw, key) {
  const { query } = await import('../../db.js');
  const r = await query(`SELECT encode(pgp_sym_encrypt($1::text, $2), 'base64') AS v`, [raw, key]);
  return r.rows[0].v;
}
async function defaultPgpDecrypt(enc, key) {
  const { query } = await import('../../db.js');
  const r = await query(`SELECT pgp_sym_decrypt(decode($1, 'base64'), $2) AS v`, [enc, key]);
  return r.rows[0].v;
}

// 同步友好接口：deps.pgpEncrypt 同步返回则整函数同步；pgcrypto 版返回 Promise（调用方 await）。
export function encryptSecret(raw, key, deps = {}) {
  const f = deps.pgpEncrypt || defaultPgpEncrypt;
  return f(raw, key);
}
export function decryptSecret(enc, key, deps = {}) {
  const f = deps.pgpDecrypt || defaultPgpDecrypt;
  return f(enc, key);
}

// —— A-B2：结构化凭据解析 ——
// 设计 §6.1 A-B2「允许 JSON 结构（纷享 appId/appSecret/permanentCode、销售易账号密钥）」。
// 判据：只认 **JSON 对象**（`{...}`）——JSON 标量（"123" / "true"）与"字符串密钥恰好长得像 JSON"
// 无法区分，盲解析会把既有单串密钥改成非字符串，属破坏性变更。
// 解析失败 → **原样返回明文**（不静默丢弃客户凭据、不返回半成品）。
export function parseCredentialPayload(plain) {
  if (typeof plain !== 'string') return plain ?? null;
  const t = plain.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return plain;
  try {
    const j = JSON.parse(t);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : plain;
  } catch {
    return plain;
  }
}

// 按租户解密指定 provider 的凭据；缺失则回退同名 env（系统级单 key 场景）。
// 返回值：字符串（单串密钥，零回归）或对象（结构化凭据，A-B2）。消费方须以 typeof 判定形状。
export async function resolveCredentials({ tenantId = 'system', providerIds = [], deps = {} } = {}) {
  const read = deps.readConfig || storeRead;
  const decrypt = deps.decrypt || ((e, k) => defaultPgpDecrypt(e, k));
  const env = deps.env || process.env;
  const row = await read('integration-secrets', { tenantId }).catch(() => null);
  const enc = (row && row.value) || {};
  const key = process.env.PGCRYPTO_SYM_KEY || '';
  const out = {};
  for (const pid of providerIds) {
    const raw = enc[pid];
    if (raw) {
      try { out[pid] = parseCredentialPayload(await decrypt(raw, key)); } catch { out[pid] = null; }
    } else {
      out[pid] = env[`${pid.toUpperCase()}_KEY`] || null;
    }
  }
  return out;
}

// 加密落库的公共写槽：fail-closed（缺密钥明确拒绝）+ upsert（禁删铁律）
async function writeEncryptedSlot({ tenantId, slot, plain, deps = {}, updatedBy = 'system' }) {
  const write = deps.writeConfig || storeWrite;
  const read = deps.readConfig || storeRead;
  const key = process.env.PGCRYPTO_SYM_KEY || deps.symKey || '';
  // fail-closed 仅对默认 pgcrypto 路径强制：注入 pgpEncrypt（单测）时由调用方自管密钥。
  if (!deps.pgpEncrypt && !key) {
    const e = new Error('PGCRYPTO_SYM_KEY 未配置：凭据加密不可用（平台密钥管理未注入）');
    e.code = 'ERR_MISSING_SYM_KEY';
    throw e;
  }
  const enc = await encryptSecret(plain, key, deps);
  const row = await read('integration-secrets', { tenantId }).catch(() => null);
  const cur = (row && row.value) || {};
  cur[slot] = enc;
  return write('integration-secrets', cur, { tenantId, updatedBy });
}

// 写侧：加密后落 config_store（禁删铁律 → upsert）。
// A-B2：接受对象（结构化凭据）——序列化后加密，密文内即 JSON，读侧由 parseCredentialPayload 还原。
//
// P0-1（2026-09-18）：平台红线——**不为用户侧形态（connector / local-bridge）持有凭据**。
//   这两形态凭据只留本机 / 对方平台，平台侧落库即违反「不保存密码」（ATTIO/ROX 均这样做）。
//   fail-closed：显式声明非平台形态 → 一律拒存并抛 ERR_CREDENTIAL_NOT_PLATFORM_HELD，绝不静默落库。
//   缺省（未传 sourceKind）视为 legacy direct（向后兼容既有调用方）。
export async function persistSecret({ tenantId = 'system', providerId, raw, deps = {}, sourceKind } = {}) {
  if (sourceKind !== undefined && sourceKind !== null && !credentialsOnPlatform(sourceKind)) {
    const e = new Error(`[ERR_CREDENTIAL_NOT_PLATFORM_HELD] 拒绝存档凭据：${sourceKind} 形态的凭据不归平台持有（红线：不保存密码）`);
    e.code = 'ERR_CREDENTIAL_NOT_PLATFORM_HELD';
    throw e;
  }
  const plain = raw && typeof raw === 'object' ? JSON.stringify(raw) : raw;
  return writeEncryptedSlot({ tenantId, slot: providerId, plain, deps });
}

// —— A-B2：token 缓存**加密落库**（值 + 过期时间），禁止模块级内存全局 ——
// 设计原文：「token 缓存值与过期时间**加密落库**，不落内存全局」。
// 故本模块**刻意不设** module-scope token 缓存变量——多实例 / 重启 / 多租户下内存缓存既不同步也不可审计。
// 槽位命名 `${providerId}:token`，与凭据槽 `${providerId}` 不冲突（resolveCredentials 按 pid 精确取键）。
const tokenSlot = (providerId) => `${providerId}:token`;

export async function persistToken({ tenantId = 'system', providerId, token, expiresAt = null, deps = {} } = {}) {
  if (!providerId || !token) {
    const e = new Error('persistToken: providerId 与 token 必填');
    e.code = 'ERR_TOKEN_ARGS';
    throw e;
  }
  return writeEncryptedSlot({
    tenantId, slot: tokenSlot(providerId),
    plain: JSON.stringify({ token, expiresAt: expiresAt ?? null }),
    deps,
  });
}

// 读 token：缺槽 / 解密失败 / 解析失败 → null（绝不返回半成品）。
// `expired` 由 expiresAt 派生，**不在此处删除或改写**（禁删铁律；过期由调用方决定是否重取）。
export async function readToken({ tenantId = 'system', providerId, deps = {} } = {}) {
  const read = deps.readConfig || storeRead;
  const key = process.env.PGCRYPTO_SYM_KEY || '';
  const row = await read('integration-secrets', { tenantId }).catch(() => null);
  const enc = (row && row.value && row.value[tokenSlot(providerId)]) || null;
  if (!enc) return null;
  try {
    // 与 decryptSecret 同一契约（deps.pgpDecrypt 注入；缺省 pgcrypto）
    const j = JSON.parse(await decryptSecret(enc, key, deps));
    const expiresAt = j?.expiresAt ?? null;
    return {
      token: j?.token ?? null,
      expiresAt,
      expired: expiresAt !== null && Number.isFinite(Number(expiresAt)) ? Date.now() >= Number(expiresAt) : false,
    };
  } catch {
    return null;
  }
}
