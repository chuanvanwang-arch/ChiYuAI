// src/llm/llmConfigStore.js — crm.llm_config 表封装（多条 LLM 配置）
// 设计：docs/2026-09-02-llm-multi-config-design.md（T1）
// 铁律：绝对禁物理 DELETE → 删除走软删 is_deleted=true；禁删 is_default 配置（返回 cannot_delete_default）
import { query } from '../db.js';
import { decryptSecret } from './secret.js';

const PROVIDER_BASE = {
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
};

// 租户过滤：admin（sysadmin）经 scopeTenant 得 '*'（跨租户通配，见 tenantScope.js）→ 不限租户；
// 否则严格按 tenant_id 过滤。写操作永不通配（scopeOf 恒取自身租户）。
const TENANT_FILTER = '($n::text = \'*\' OR tenant_id = $n)';
function tenantSql(param) {
  return TENANT_FILTER.replaceAll('$n', param);
}

// 列表（脱敏由调用方处理；此处返回全字段供水合）
export async function listConfigs(tenantId = 'system') {
  const r = await query(
    `SELECT id,name,provider,model,base_url,temp,max_tokens,is_default,tenant_id,updated_at
     FROM crm.llm_config WHERE ${tenantSql('$1')} AND NOT is_deleted ORDER BY is_default DESC, name`,
    [tenantId]
  );
  return r.rows;
}

export async function getAllActive(tenantId = 'system') {
  const r = await query(
    `SELECT * FROM crm.llm_config WHERE ${tenantSql('$1')} AND NOT is_deleted ORDER BY created_at`,
    [tenantId]
  );
  return r.rows;
}

// 默认配置：优先 is_default=true；无显式默认则取最早创建的一条（保证单条存量场景不倒退）
export async function getDefault(tenantId = 'system') {
  const r = await query(
    `SELECT * FROM crm.llm_config WHERE ${tenantSql('$1')} AND NOT is_deleted
     ORDER BY is_default DESC, created_at LIMIT 1`,
    [tenantId]
  );
  return r.rows[0] || null;
}

export async function getByName(name, tenantId = 'system') {
  const r = await query(
    `SELECT * FROM crm.llm_config WHERE name=$1 AND ${tenantSql('$2')} AND NOT is_deleted`,
    [name, tenantId]
  );
  return r.rows[0] || null;
}

export async function upsertConfig(p) {
  const { id, name, provider, model, base_url, api_key, temp, max_tokens, is_default, tenantId = 'system', updated_by } = p;
  if (is_default) {
    await query('UPDATE crm.llm_config SET is_default=false WHERE tenant_id=$1 AND NOT is_deleted', [tenantId]);
  }
  if (id) {
    const r = await query(
      `UPDATE crm.llm_config SET name=$2,provider=$3,model=$4,base_url=$5,
         api_key=COALESCE($6,api_key),temp=COALESCE($7,temp),max_tokens=COALESCE($8,max_tokens),
         is_default=COALESCE($9,is_default),updated_at=now(),updated_by=$10
       WHERE id=$1 RETURNING *`,
      [id, name, provider, model, base_url, api_key ?? null, temp ?? null, max_tokens ?? null, is_default ?? null, updated_by]
    );
    return r.rows[0];
  }
  // 真 upsert 语义（2026-09-03）：name 为全局 UNIQUE，同名（含已软删行）必须走冲突更新而非 INSERT 报错。
  // 撞键时一并复位 is_deleted=false（复用历史行），否则软删残留会让同名配置永久无法重建。
  const r = await query(
    `INSERT INTO crm.llm_config (name,provider,model,base_url,api_key,temp,max_tokens,is_default,tenant_id,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (name) DO UPDATE SET
       provider=EXCLUDED.provider, model=EXCLUDED.model, base_url=EXCLUDED.base_url,
       api_key=EXCLUDED.api_key, temp=EXCLUDED.temp, max_tokens=EXCLUDED.max_tokens,
       is_default=EXCLUDED.is_default, tenant_id=EXCLUDED.tenant_id,
       updated_by=EXCLUDED.updated_by, updated_at=now(), is_deleted=false
     RETURNING *`,
    [name, provider, model, base_url, api_key ?? null, temp ?? 0.7, max_tokens ?? 1024, is_default ?? false, tenantId, updated_by]
  );
  return r.rows[0];
}

// 软删（绝物理 DELETE）；default 拒绝
export async function deleteConfig(id, tenantId = 'system') {
  const cur = await query('SELECT * FROM crm.llm_config WHERE id=$1 AND tenant_id=$2 AND NOT is_deleted', [id, tenantId]);
  if (!cur.rows[0]) return { ok: false, error: 'not_found' };
  if (cur.rows[0].is_default) return { ok: false, error: 'cannot_delete_default' };
  await query('UPDATE crm.llm_config SET is_deleted=true, updated_at=now() WHERE id=$1', [id]);
  return { ok: true };
}

export async function setDefault(id, tenantId = 'system') {
  await query('UPDATE crm.llm_config SET is_default=false WHERE tenant_id=$1 AND NOT is_deleted', [tenantId]);
  const r = await query('UPDATE crm.llm_config SET is_default=true WHERE id=$1 AND tenant_id=$2 RETURNING *', [id, tenantId]);
  return r.rows[0] || null;
}

// 水合：解密 api_key + 补 base；无效返回 null
// 只要求 base 有效（apiKey 可为 null，兼容免密/本地端点），与 client.js 回退源同一契约
export function hydrate(cfg) {
  if (!cfg) return null;
  const apiKey = cfg.api_key ? decryptSecret(cfg.api_key) : null;
  const base = normalizeBase(cfg.base_url || PROVIDER_BASE[cfg.provider]);
  if (!base) return null;
  return { ...cfg, apiKey, base };
}

function normalizeBase(url) {
  if (!url) return null;
  const s = String(url).trim().replace(/\/+$/, '');
  if (!s) return null;
  return /\/chat\/completions$/.test(s) ? s : `${s}/chat/completions`;
}
