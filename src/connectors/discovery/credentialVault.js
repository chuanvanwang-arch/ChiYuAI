// src/connectors/discovery/credentialVault.js
// 凭据保险库：加密落库（pgcrypto at-rest）+ 运行时按租户解密注入 ctx.credentials。
// 绝不进前端、不进日志、不进 memory。deps 注入使得单测零 DB。
import { readConfig as storeRead, writeConfig as storeWrite } from '../../config/configStore.js';

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

// 按租户解密指定 provider 的凭据；缺失则回退同名 env（系统级单 key 场景）。
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
      try { out[pid] = await decrypt(raw, key); } catch { out[pid] = null; }
    } else {
      out[pid] = env[`${pid.toUpperCase()}_KEY`] || null;
    }
  }
  return out;
}

// 写侧：加密后落 config_store（禁删铁律 → upsert）。
// fail-closed：PGCRYPTO_SYM_KEY 未注入时明确拒绝并点名原因（否则 pgcrypto 抛
// 'Illegal argument to function' 等晦涩错误，运维无法定位 = 平台密钥管理铁律的护栏）。
export async function persistSecret({ tenantId = 'system', providerId, raw, deps = {} } = {}) {
  const write = deps.writeConfig || storeWrite;
  const read = deps.readConfig || storeRead;
  const key = process.env.PGCRYPTO_SYM_KEY || deps.symKey || '';
  // fail-closed 仅对默认 pgcrypto 路径强制：注入 pgpEncrypt（单测）时由调用方自管密钥。
  if (!deps.pgpEncrypt && !key) {
    const e = new Error('PGCRYPTO_SYM_KEY 未配置：凭据加密不可用（平台密钥管理未注入）');
    e.code = 'ERR_MISSING_SYM_KEY';
    throw e;
  }
  const enc = deps.pgpEncrypt
    ? await encryptSecret(raw, key, deps)
    : await encryptSecret(raw, key);
  const row = await read('integration-secrets', { tenantId }).catch(() => null);
  const cur = (row && row.value) || {};
  cur[providerId] = enc;
  return write('integration-secrets', cur, { tenantId, updatedBy: 'system' });
}
