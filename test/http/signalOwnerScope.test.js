// test/http/signalOwnerScope.test.js — T21 信号个人隔离（2026-09-16 用户指令「除管理外，需要进行个人隔离！」）
//
// 为什么需要本文件：
//   隔离判定的结果直接决定「这个销售员能不能看到别人的客户信号」——属安全边界。
//   若只在 HTTP 端点或工作台视角各写一份判定，极易「修一处漏一处」→ **部分假绿**（验收会通过）。
//   故：① 纯函数单测锁语义；② 静态守卫锁「两处消费点都走同一事实源」；
//   ③ 真库串联（signalOwnerScope → store.list）验证下游效果，非只验函数返回值。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signalOwnerScope } from '../../src/http/tenantScope.js';
import { createSignalStore } from '../../src/signal/store.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------- ① 纯函数语义 ----------
describe('signalOwnerScope：作用域判定（唯一事实源）', () => {
  it('管理（admin/sysadmin）未显式收窄 → null（全量视界）', () => {
    expect(signalOwnerScope({ username: 'admin', role: 'admin' })).toBeNull();
    expect(signalOwnerScope({ username: 'root', role: 'sysadmin' })).toBeNull();
  });

  it('管理显式 ?mine=1 → 收窄到自身（管理也能只看自己的）', () => {
    expect(signalOwnerScope({ username: 'admin', role: 'admin' }, { mine: true }))
      .toEqual({ username: 'admin', role: 'admin' });
  });

  it('普通角色 → 强制自身作用域（不看 mine 参数）', () => {
    const expected = { username: 'alice', role: 'sales' };
    expect(signalOwnerScope({ username: 'alice', role: 'sales' })).toEqual(expected);
    // 鉴别力：若实现里写成 `if (isAdmin || !mine) return null`（把非管理员也算全量），此断言红
    expect(signalOwnerScope({ username: 'alice', role: 'sales' }, { mine: false })).toEqual(expected);
    expect(signalOwnerScope({ username: 'alice', role: 'sales' }, { mine: true })).toEqual(expected);
    expect(signalOwnerScope({ username: 'mgr', role: 'manager' })).toEqual({ username: 'mgr', role: 'manager' });
  });

  it('fail-closed：身份字段缺失时**不**退回 null（否则隔离退化为泄漏）', () => {
    // 无 me / me 无 username → 仍返回对象（username 为空串 → 下游谓词匹配不到任何行）
    expect(signalOwnerScope(null)).toEqual({ username: '', role: null });
    expect(signalOwnerScope(undefined)).toEqual({ username: '', role: null });
    expect(signalOwnerScope({ role: 'sales' })).toEqual({ username: '', role: 'sales' });
    // 唯一返回 null 的情形：确认是管理员
    expect(signalOwnerScope({ role: 'admin' })).toBeNull();
  });

  // 2026-09-16 实测踩坑：两处调用点的 me 形状不同——HTTP 侧 { username, role }，
  //   工作台 currentActor 返回 { username, roles: [me.role] }。若只读 me.role，
  //   工作台侧 role 落 NULL → target_role=NULL 永假 → 连无主广播都看不到（过度收窄）。
  it('兼容工作台 actor 形态（roles 数组）：行为与 HTTP 侧一致', () => {
    // 普通销售员（工作台 actor 形态）
    expect(signalOwnerScope({ username: 'alice', roles: ['sales'], tenantId: 't1' }))
      .toEqual({ username: 'alice', role: 'sales' });
    // 管理员 → 全量
    expect(signalOwnerScope({ username: 'admin', roles: ['admin'], tenantId: 'system' })).toBeNull();
    expect(signalOwnerScope({ username: 'root', roles: ['sysadmin'] })).toBeNull();
    // 管理员显式收窄
    expect(signalOwnerScope({ username: 'admin', roles: ['admin'] }, { mine: true }))
      .toEqual({ username: 'admin', role: 'admin' });
  });
});

// ---------- ② 静态守卫：两处消费点同源 ----------
describe('接线守卫：隔离判定不得在消费点重写（防只修一处＝部分假绿）', () => {
  const routesSrc = read('src/http/routes.js');
  const wbSrc = read('src/http/workbenchRouter.js');

  it('两处消费点都从 tenantScope.js 导入 signalOwnerScope', () => {
    const imp = /import \{[^}]*signalOwnerScope[^}]*\} from '\.\/tenantScope\.js'/;
    expect(routesSrc).toMatch(imp);
    expect(wbSrc).toMatch(imp);
  });

  it('/api/signals 读路径把 ownerScope 传给 store.list，并以 meta 回传作用域', () => {
    // 扫描有效性对照：先确认文件内容真的被读到（否则空串会让下面断言以奇怪方式通过）
    expect(routesSrc.length).toBeGreaterThan(10000);
    expect(routesSrc).toMatch(/const ownerScope = signalOwnerScope\(me, \{ mine: req\.query\.mine === '1' \}\)/);
    expect(routesSrc).toMatch(/signalStore\.list\(\{[\s\S]{0,500}?ownerScope,/);
    expect(routesSrc).toMatch(/owner_scope/);
  });

  it('工作台第7视角把 ownerScope 传给 store.list', () => {
    expect(wbSrc).toMatch(/ownerScope: signalOwnerScope\(actor\)/);
  });

  it('routes.js 的**每个** signalStore.list 调用都带 ownerScope（防将来新增读路径漏隔离）', () => {
    const calls = [...routesSrc.matchAll(/signalStore\.list\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0); // 守卫自检：确实扫到调用点
    const leaked = calls.filter((c) => !/ownerScope/.test(c));
    expect(leaked).toEqual([]);
  });
});

// ---------- ③ 真库串联：函数判定 → store 谓词 → 实际可见行 ----------
describe('端到端串联（真库 crm_native_test）：作用域真的收窄了可见行', () => {
  const T = '__iso_' + process.pid + '_' + Date.now();
  let pool;
  beforeAll(async () => {
    pool = new pg.Pool({ database: process.env.PGDATABASE || 'crm_native_test', host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b' });
    await pool.query('SET search_path TO crm,public');
    const store = createSignalStore(pool);
    await store.create({ tenant_id: T, source: 'rule-scan', kind: 'visit_shortfall', severity: 'high', target_role: 'sales', owner_id: 'alice' });
    await store.create({ tenant_id: T, source: 'rule-scan', kind: 'visit_shortfall', severity: 'high', target_role: 'sales', owner_id: 'bob' });
    await store.create({ tenant_id: T, source: 'rule-scan', kind: 's0_stale', severity: 'medium', target_role: 'sales', owner_id: null });
  });
  afterAll(async () => {
    await pool.query('DELETE FROM crm.signal WHERE tenant_id=$1', [T]).catch(() => {});
    await pool.end();
  });

  it('alice 看不到 bob 的信号；能看到自己的 + 无主公海', async () => {
    const store = createSignalStore(pool);
    const rows = await store.list({ tenant_id: T, ownerScope: signalOwnerScope({ username: 'alice', role: 'sales' }) });
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.owner_id === 'bob')).toBe(false);
  });

  it('管理员 → 全部 3 行（隔离对管理不生效）', async () => {
    const store = createSignalStore(pool);
    const rows = await store.list({ tenant_id: T, ownerScope: signalOwnerScope({ username: 'admin', role: 'admin' }) });
    expect(rows.length).toBe(3);
  });

  it('身份缺失（无 username）→ fail-closed 返回 0 行，而非全量', async () => {
    const store = createSignalStore(pool);
    const rows = await store.list({ tenant_id: T, ownerScope: signalOwnerScope(null) });
    expect(rows.length).toBe(0);
  });

  // 迁移守卫：owner_id 成为读路径过滤列后必须有索引（旧库未跑 migrate 即红）
  it('索引守卫：idx_signal_owner 在真库存在（迁移未执行即红）', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='crm' AND tablename='signal' AND indexname='idx_signal_owner'`
    );
    expect(rows.length).toBe(1);
  });
});
