// 将 LLM/Embedding 凭据写入生产库（加密落库，明文用完即删）
//
// 背景：生产库是新库，crm.llm_config 为空 → embedText() 的 model 分支拿不到 api_key，
//       恒降级为 hashVector(384)。本脚本补齐配置，使语义向量（BAAI/bge-large-zh-v1.5, 1024维）生效。
//
// 安全设计：
//   - 明文只经文件传入，不出现在命令行/环境变量/日志中
//   - 落库前用项目自身的 encryptSecret 加密（AES-256-GCM，密钥 CRM_LLM_SECRET || PORTAL_JWT_SECRET || 默认）
//   - 写入成功后立即删除明文文件（unlinkSync）
//   - 输出只含密文长度，不打印明文
//
// 用法（在 app 容器内执行）：
//   docker cp seed-llm-key.js crm-app:/tmp/seed-llm-key.js
//   docker cp llm_key.txt      crm-app:/tmp/llm_key.txt        # 明文，用完即删
//   docker exec crm-app node /tmp/seed-llm-key.js
import fs from 'node:fs';
import pg from 'pg';

const PLAIN_PATH = '/tmp/llm_key.txt';
const NAME = process.env.LLM_CONFIG_NAME || 'siliconflow';
const PROVIDER = process.env.LLM_PROVIDER || 'siliconflow';
// ⚠ model 是 chat 模型（用于 LLM 推理）；embedding 走 embeddingClient.js 内独立的
//   BAAI/bge-large-zh-v1.5（env EMBEDDING_MODEL 优先），不会误用此 chat 模型。
const MODEL = process.env.LLM_MODEL || 'deepseek-ai/DeepSeek-V4-Flash';
const BASE_URL = process.env.LLM_BASE_URL || 'https://api.siliconflow.cn/v1';

let { encryptSecret } = { encryptSecret: null };
try {
  ({ encryptSecret } = await import('/app/src/llm/secret.js'));
} catch {
  ({ encryptSecret } = await import('./src/llm/secret.js'));
}

if (!fs.existsSync(PLAIN_PATH)) {
  console.error(`明文文件不存在: ${PLAIN_PATH}`);
  process.exit(1);
}
const plain = fs.readFileSync(PLAIN_PATH, 'utf8').trim();
if (!plain) {
  console.error('明文为空，拒绝写入');
  process.exit(1);
}

const cipher = encryptSecret(plain);

const client = new pg.Client({
  host: process.env.PGHOST || 'db',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

await client.connect();
await client.query('SET search_path TO crm, public');
const res = await client.query(
  `INSERT INTO crm.llm_config (name, provider, model, base_url, api_key, is_default, is_deleted, tenant_id)
   VALUES ($1,$2,$3,$4,$5,true,false,'system')
   ON CONFLICT (name) DO UPDATE SET
     provider=EXCLUDED.provider, model=EXCLUDED.model, base_url=EXCLUDED.base_url,
     api_key=EXCLUDED.api_key, is_default=true, is_deleted=false`,
  [NAME, PROVIDER, MODEL, BASE_URL, cipher]
);

// 明文用完即删（避免在生产容器留下明文凭据）
fs.unlinkSync(PLAIN_PATH);

const check = await client.query(
  'select name, provider, model, base_url, is_default, left(api_key,3) as cipher_prefix from crm.llm_config where name=$1',
  [NAME]
);
console.log('LLM_CONFIG_UPSERTED rows=' + (res.rowCount ?? 1));
console.log(JSON.stringify(check.rows[0]));
await client.end();
