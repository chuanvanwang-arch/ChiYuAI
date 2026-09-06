// src/mcp/tokenFormat.js — MCP token 明文格式单一事实源（颁发侧与解析侧共用）
// 设计：docs/2026-09-01-mcp-token-lookup-design.md §4.1–§4.2
//
// 背景：旧 token 为裸 48 位 hex，解析时只能逐行 crypt 比对（WHERE token_hash = crypt($1, token_hash)），
//       无法走索引 → 全表扫描 O(n)，成本随登录次数线性劣化（生产 110 行 ≈500ms，测试库 1301 行 ≈4.6s）。
// 改造：明文编入 identity_id（AWS Access Key ID 同款实践），解析时先用 id 走主键索引定位单行，
//       再对该行做一次 crypt 校验 → O(1)。
//
// 安全：整个 token 串（含 id 段）参与 crypt 哈希，篡改 id 段会令校验失败；
//       identity_id 为随机 UUID、不含业务语义；明文 token 仍遵守「永不出 node 进程到日志」纪律。
import { randomUUID, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'crm';

// crm_<id32：UUID 去横线>_<secret48：24 字节 hex = 192bit>
export const TOKEN_RE = /^crm_([0-9a-f]{32})_([0-9a-f]{48})$/;

// 生成结构化 token。显式返回 id，供 INSERT 时指定主键（DEFAULT gen_random_uuid() 仅在省略该列时生效），
// 从而做到单次 INSERT，无需先插后 UPDATE 回填。
export function newStructuredToken() {
  const id = randomUUID();
  const secret = randomBytes(24).toString('hex');
  return { id, tokenPlain: `${TOKEN_PREFIX}_${id.replace(/-/g, '')}_${secret}` };
}

// 解析出 identity_id（带横线 UUID 形态）；格式不符返回 null，
// 调用方据此在「格式闸」直接降级，零 DB 查询。
export function parseTokenId(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
