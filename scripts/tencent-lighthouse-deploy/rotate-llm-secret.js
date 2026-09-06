// 轮换 crm.llm_config.api_key 的加密主密钥（CRM_LLM_SECRET）
//
// 背景：生产未设 CRM_LLM_SECRET，用的是开发默认 'crm-dev-secret'（secret.js:7 第三级回退）。
//      默认密钥等于「密钥公开」，等同于明文存储，必须轮换为强随机值。
//
// 为什么必须按「先解密 → 再换密钥加密 → 最后重启」的顺序：
//   若先改 .env 再重启，库里旧密文（默认密钥加密）将无法用新密钥解密 →
//   hydrate() 解密失败 → apiKey 为 null → embedText 降级 hash，留下降级窗口。
//   故本脚本在「旧密钥仍生效」时完成密文轮换，重启后新密钥直接可用。
//
// 安全设计：
//   - 新密钥用 crypto.randomBytes(32) 生成，全程不打印到 stdout
//   - 新密钥写入 /app/.new_secret（权限 600），由外部取回写入 .env，不落终端日志
//   - 明文仅在内存中存在，不落盘
//
// 用法（在 app 容器内执行，此时旧密钥=默认，尚未设置 CRM_LLM_SECRET）：
//   docker cp rotate-llm-secret.js crm-app:/app/rotate-llm-secret.js
//   docker exec crm-app node /app/rotate-llm-secret.js
//   docker cp crm-app:/app/.new_secret /tmp/new_secret.txt      # 取回新密钥
//   printf 'CRM_LLM_SECRET=%s\n' "$(cat /tmp/new_secret.txt)" >> .env
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const NAME = process.env.LLM_CONFIG_NAME || 'siliconflow';
const OUT_PATH = '/app/.new_secret';

// ── 阶段 1：用「当前生效」的密钥解密，取回明文 ──
// （此刻容器未设 CRM_LLM_SECRET，即 secret.js 走默认回退）
const sOld = await import('/app/src/llm/secret.js');

const client = new pg.Client({
  host: process.env.PGHOST || 'db',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});
await client.connect();
await client.query('SET search_path TO crm, public');

const { rows } = await client.query('select api_key from crm.llm_config where name=$1', [NAME]);
if (!rows.length) {
  await client.end();
  throw new Error(`未找到 llm_config 条目: ${NAME}`);
}
const plain = sOld.decryptSecret(rows[0].api_key);
if (typeof plain !== 'string' || !plain.length) {
  await client.end();
  throw new Error('旧密钥解密失败，中止轮换（库内密文可能被改过）');
}

// ── 阶段 2：生成强随机新密钥，并用它重新加密 ──
const NEW_SECRET = crypto.randomBytes(32).toString('base64');
process.env.CRM_LLM_SECRET = NEW_SECRET;
// ESM 模块缓存：加 query 强制重新加载，使新密钥生效
const sNew = await import('/app/src/llm/secret.js?rot=' + Date.now());

const newCipher = sNew.encryptSecret(plain);

// ── 阶段 3：自校验（用新密钥解密必须还原出同一明文），通过后才落库 ──
const back = sNew.decryptSecret(newCipher);
if (back !== plain) {
  await client.end();
  throw new Error('自校验失败：新密文无法还原为原文，已中止（库未改动）');
}

await client.query('update crm.llm_config set api_key=$1 where name=$2', [newCipher, NAME]);

// 新密钥落盘（600），供外部取回写入 .env；不打印内容
fs.writeFileSync(OUT_PATH, NEW_SECRET, { mode: 0o600 });

const check = await client.query(
  'select name, left(api_key,3) as cipher_prefix, length(api_key) as cipher_len from crm.llm_config where name=$1',
  [NAME]
);
console.log('SECRET_ROTATED ' + JSON.stringify(check.rows[0]));
console.log('NEW_SECRET_WRITTEN_TO=' + OUT_PATH + ' (请取回后写入 .env 并重启服务)');
await client.end();
