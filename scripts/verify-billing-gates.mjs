// scripts/verify-billing-gates.mjs — 套餐闸门有效性本地验证（P0-1 计量下沉 / P0-2 用量回填 / P1-1 缺租户 fail-closed / P2 档位权益拦截）
// 用法：node scripts/verify-billing-gates.mjs （连本地库 crm_native，会写入少量 token_accounting 测试行，actor=gate-verify）
process.env.PGDATABASE = 'crm_native';
import pg from 'pg';
import { recordUsage, meteringTenantId, enforceQuotaFor } from '../src/billing/metering.js';
import { actionExecutor } from '../src/action/executor.js';
import { listActions } from '../src/action/registry.js';
import { seedActions } from '../src/action/seed-actions.js';
await seedActions();

const db = new pg.Client('postgres://agent2b:agent2b@localhost:5433/crm_native');
await db.connect();
await db.query('SET search_path TO crm,public');

const PERIOD = new Date().toISOString().slice(0, 7);
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} | ${name} | ${detail}`); };

// ── 取一个合规 decision_id（供 write 类 action 过第 0 闸）──
let DEC = null;
try {
  const r = await db.query('SELECT decision_id FROM crm.decision LIMIT 1');
  DEC = r.rows[0]?.decision_id || null;
} catch { DEC = null; }

// ── 前置：token_accounting 基线 ──
const baseOf = async (tid) => {
  const r = await db.query("SELECT count(*)::int AS n, COALESCE(sum(tokens_in+tokens_out),0)::int AS tok FROM crm.token_accounting WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2", [tid, PERIOD]);
  return r.rows[0];
};

// ===== 1) P0-1 计量下沉：带 tenantId 的调用必须落库 =====
const t1 = 'acme-chem';
const b1 = await baseOf(t1);
await recordUsage({ metering: { tenantId: t1, actor: 'gate-verify', action: 'verify-1' }, source: 'llm', usage: { prompt_tokens: 111, completion_tokens: 222 } });
const a1 = await baseOf(t1);
check('P0-1 带租户计量落库', a1.n === b1.n + 1 && a1.tok === b1.tok + 333, `rows ${b1.n}→${a1.n}, tokens ${b1.tok}→${a1.tok}（期望 +333）`);

// ===== 2) P0-1 缺 tenantId：记 system + 不阻断（方案 B）=====
const b2 = await baseOf('system');
const r2 = await recordUsage({ metering: null, source: 'llm', action: 'verify-2', usage: { prompt_tokens: 7, completion_tokens: 3 } });
const a2 = await baseOf('system');
check('P0-1 缺租户记 system 不阻断', r2.tenantId === 'system' && a2.n === b2.n + 1, `tenantId=${r2.tenantId}, rows ${b2.n}→${a2.n}`);
check('P0-1 meteringTenantId 兜底', meteringTenantId(undefined, 'x') === 'system', `返回 ${meteringTenantId(undefined, 'x')}`);

// ===== 3) P0-2 onUsage 回传（Action 真实用量回填通道）=====
let backfill = null;
await recordUsage({ metering: { tenantId: t1, actor: 'gate-verify', action: 'verify-3' }, source: 'llm', usage: { prompt_tokens: 40, completion_tokens: 60 }, onUsage: (u) => { backfill = u; } });
check('P0-2 onUsage 回传真实用量', backfill && backfill.tokensIn === 40 && backfill.tokensOut === 60, JSON.stringify(backfill));

// ===== 4) 配额预检：system 豁免 / 业务租户走真实预检 =====
try {
  const q = await enforceQuotaFor({ tenantId: 'acme-chem' }, 'llm');
  check('P0-1 配额预检可执行', q && typeof q.ok === 'boolean', JSON.stringify(q));
} catch (e) {
  check('P0-1 配额预检可执行', !e.isQuota, `抛错 isQuota=${e.isQuota} msg=${e.message}`);
}

// ===== 5) P1-1 缺 tenantId → fail-closed =====
// 找一个声明了 requiresEntitlement 的 action
const guarded = listActions().filter((a) => Array.isArray(a.requiresEntitlement) && a.requiresEntitlement.length);
check('P2 权益门禁覆盖面', guarded.length > 14, `声明门禁的 Action 数 = ${guarded.length}（改造前 14）`);

const sample = guarded[0];
const resNoTenant = await actionExecutor.dispatch(sample.name, {}, { actor: 'gate-verify', decision_id: DEC, ...(sample.kind === 'write' ? {} : {}) });
check('P1-1 缺租户 fail-closed', resNoTenant.ok === false && /tenant/i.test(resNoTenant.gate || resNoTenant.error || ''),
  `action=${sample.name} gate=${resNoTenant.gate} error=${resNoTenant.error}`);

// ===== 6) P2 低档位租户：高档位权益应被拦 =====
// acme-chem = starter（6 权益），找一个 starter 不具备的权益
const starter = (await db.query("SELECT p.value FROM crm.config_store, jsonb_array_elements(value) AS p WHERE tenant_id='system' AND key='billing-plans' AND p->>'plan_id'='starter'")).rows[0]?.value || {};
const starterEnts = new Set(starter.entitlements || []);
const hi = guarded.find((a) => a.requiresEntitlement.some((k) => !starterEnts.has(k)));
if (hi) {
  const r6 = await actionExecutor.dispatch(hi.name, {}, { tenantId: 'acme-chem', actor: 'gate-verify', decision_id: DEC });
  const blocked = r6.ok === false && (r6.gate === 'plan_entitlement' || /权益|升级套餐/.test(r6.error || ''));
  check('P2 低档位权益拦截', blocked, `action=${hi.name} 需 ${hi.requiresEntitlement.join(',')} | gate=${r6.gate} error=${r6.error}`);
} else {
  check('P2 低档位权益拦截', false, '未找到 starter 不具备的高档权益 action');
}

// ===== 7) 高档位权益放行对照（system 恒豁免）=====
if (hi) {
  const r7 = await actionExecutor.dispatch(hi.name, {}, { tenantId: 'system', actor: 'gate-verify', decision_id: DEC });
  check('P2 system 豁免对照', r7.gate !== 'plan_entitlement', `gate=${r7.gate || 'none'} ok=${r7.ok} error=${r7.error || ''}`);
}

await db.end();

const failed = results.filter((r) => !r.pass);
console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log('失败项:'); failed.forEach((f) => console.log(' -', f.name, '|', f.detail)); process.exit(1); }
