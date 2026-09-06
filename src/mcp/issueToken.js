// src/mcp/issueToken.js — 颁发 MCP 接入 token（零信任：明文仅返回给调用方，库只存 pgcrypto 哈希）
// 设计输入：docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md §3
// 纪律：明文 token 永不出 node 进程到日志/响应；吊销走 revoked_at 软标记（绝对禁删）
// 幂等语义（2026-08-26 修复）：同 actor+role_tag 未吊销已存在 → 不重复插、不伪造新明文，
//   返回 { tokenPlain: null, identityId, alreadyExists: true } —— 明文仅首次颁发的这一次有效，
//   重复调用者应提示「token 已颁发，明文不可再次获取」（哈希不可逆，库中无明文可回读）。
import { query, queryWrite } from '../db.js';
import { newStructuredToken } from './tokenFormat.js';

// 生成明文 token（结构化：crm_<id32>_<secret48>），用 pgcrypto crypt 哈希入库；
// id 由本侧预先生成并显式写入主键，使解析侧可走主键索引定位（设计 §4.2）。
// scopes: { deny_domains?: string[] }
export async function issueToken({ actor, roleTag, scopes = {}, expiresAt = null, personId = null }) {
  const { id, tokenPlain } = newStructuredToken();
  const r = await queryWrite(
    `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at)
       SELECT $1, crypt($2, gen_salt('bf')), $3, $4, $5, $6::jsonb, $7
       WHERE NOT EXISTS (
         SELECT 1 FROM crm.mcp_identity WHERE actor=$3 AND role_tag=$5 AND revoked_at IS NULL
       )
       RETURNING id`,
    [id, tokenPlain, actor, personId, roleTag, JSON.stringify(scopes), expiresAt]
  );
  // 幂等：已存在 → 不返回新明文（哈希不可逆，无法回读），仅回现有 id
  if (!r.rows[0]?.id) {
    const e = await query(
      `SELECT id FROM crm.mcp_identity WHERE actor=$1 AND role_tag=$2 AND revoked_at IS NULL LIMIT 1`,
      [actor, roleTag]
    );
    if (e.rows[0]?.id) {
      return { tokenPlain: null, identityId: e.rows[0].id, alreadyExists: true };
    }
    throw new Error(`issueToken 幂等分支异常：actor=${actor} roleTag=${roleTag} 既未插入也未找到现有行`);
  }
  return { tokenPlain, identityId: r.rows[0].id, alreadyExists: false };
}