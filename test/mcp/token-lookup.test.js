// test/mcp/token-lookup.test.js — 凭证解析三段式：格式闸 / 主键定位 / 单次 crypt（设计 §4.4）
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../../src/db.js';
import { resolveIdentity } from '../../src/mcp/auth.js';
import { issueToken } from '../../src/mcp/issueToken.js';
import { parseTokenId } from '../../src/mcp/tokenFormat.js';

let tok, identId, actorName;

beforeAll(async () => {
  actorName = `lk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const r = await issueToken({ actor: actorName, roleTag: 'sales', scopes: {} });
  tok = r.tokenPlain;
  identId = r.identityId;
}, 60000);

describe('resolveIdentity 三段式', () => {
  it('有效 token → 正常解析（actor/role/identity_id 正确，非 degraded）', async () => {
    const r = await resolveIdentity(tok);
    expect(r.degraded).toBe(false);
    expect(r.actor).toBe(actorName);
    expect(r.role).toBe('sales');
    expect(String(r.identity_id)).toBe(String(identId));
  }, 60000);

  it('格式闸：旧格式裸 hex token → degraded 且 reason 提示重新登录', async () => {
    const r = await resolveIdentity('a'.repeat(48));
    expect(r.degraded).toBe(true);
    expect(r.degraded_reason).toContain('重新 crm_login');
    expect(r.actor).toBeNull();
  }, 60000);

  it('格式闸：空/无凭证 → degraded（无 token 分支保持既有文案）', async () => {
    const r = await resolveIdentity('');
    expect(r.degraded).toBe(true);
    expect(r.degraded_reason).toContain('无凭证');
  }, 60000);

  it('篡改 id 段 → degraded（整个串参与哈希，篡改即校验失败）', async () => {
    const [prefix, id32, secret] = tok.split('_');
    const fakeId = 'f'.repeat(32);
    const forged = `${prefix}_${fakeId}_${secret}`;
    const r = await resolveIdentity(forged);
    expect(r.degraded).toBe(true);
    // 篡改后解析出的 id 与真实 id 不同 → 要么查不到行，要么 crypt 不匹配
    expect(parseTokenId(forged)).not.toBe(parseTokenId(tok));
  }, 60000);

  it('已吊销 token → degraded', async () => {
    await query(`UPDATE crm.mcp_identity SET revoked_at = now() WHERE id=$1`, [identId]);
    const r = await resolveIdentity(tok);
    expect(r.degraded).toBe(true);
    expect(r.degraded_reason).toContain('吊销');
    // 复原，避免影响后续用例
    await query(`UPDATE crm.mcp_identity SET revoked_at = NULL WHERE id=$1`, [identId]);
  }, 60000);

  it('性能门槛：解析 ≤50ms（改造前 1300+ 行时约 4600ms）', async () => {
    const t0 = Date.now();
    const r = await resolveIdentity(tok);
    const ms = Date.now() - t0;
    expect(r.degraded).toBe(false);
    expect(ms).toBeLessThanOrEqual(50);
  }, 60000);

  it('SQL 形态：不再出现 crypt($1, token_hash) 全表扫描', async () => {
    // 只检查代码行：注释里为说明改造背景会引用旧 SQL 形态，须先剥离行注释
    const src = await import('node:fs').then(fs =>
      fs.promises.readFile(new URL('../../src/mcp/auth.js', import.meta.url), 'utf8'));
    const codeOnly = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(codeOnly).not.toContain('crypt($1, token_hash)');
    // 且必须存在主键定位形态（② 主键定位 + ③ 单次 crypt）
    expect(codeOnly).toContain('WHERE id = $1');
    expect(codeOnly).toContain('crypt($2, token_hash)');
  }, 60000);
});
