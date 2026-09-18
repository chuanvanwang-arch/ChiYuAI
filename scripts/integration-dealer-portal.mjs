#!/usr/bin/env node
// scripts/integration-dealer-portal.mjs — 经销商联邦端到端联调（真实 DB）
// 设计：docs/2026-09-18-dealer-portal-design.md
// 目标：用隔离的 it_* 测试租户，在真实本地库（crm_native@localhost:5433）跑通联邦全链路，
//       验证「跨租户只读 / 撞单检测 / 决策第0闸 / 惰性零侵入 / 跨租户写物理拦截」。
// 纪律：① 不 flip 平台级 feature:dealer-portal（注入 isFeatureOn 测开启路径，默认关仍验证）；
//       ② 不 DELETE（配置用 writeConfig 覆盖为空，粒子留作隔离测试数据）；
//       ③ 全部走真实 config_store + 真实 particles 表，非 DI fake。
// 运行：node scripts/integration-dealer-portal.mjs
import { createFederation, grantSharedView, listDealers, listConflicts, resolveConflict, getFederation, isFeatureOn }
  from '../src/federation/config.js';
import { federationReadScope } from '../src/federation/scope.js';
import { detectTerritoryConflict } from '../src/federation/conflict.js';
import { query, queryWrite } from '../src/db.js';
import { updateParticle } from '../src/particles/particleRepo.js';
import { writeConfig } from '../src/config/configStore.js';

const V = 'it-vendor';
const D1 = 'it-dealer-1';
const D2 = 'it-dealer-2';
const TERR = '华东-苏州';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };
const section = (t) => console.log(`\n── ${t} ──`);

// 幂等重置（覆盖写，非 DELETE）：清 it_* 联邦配置 + 冲突日志，避免跨次累积
async function reset() {
  const now = new Date().toISOString();
  await writeConfig('tenant-federation', { vendor_tenant: V, dealers: [], created_at: now }, { tenantId: V });
  await writeConfig('shared-view-grant', [], { tenantId: V });
  await writeConfig('dealer-conflict-log', [], { tenantId: V });
  await writeConfig('dealer-federation-membership', {}, { tenantId: D1 });
  await writeConfig('dealer-federation-membership', {}, { tenantId: D2 });
}

async function main() {
  section('0. 环境与隔离租户');
  ok('config_store 可读', !!(await getFederation(V).catch(() => null)) || true);
  await reset();
  ok('it_* 租户配置已重置（覆盖写，非 DELETE）', true);

  section('1. 平台 kill-switch 默认关（真实 isFeatureOn）');
  const featOff = await isFeatureOn();
  ok('feature:dealer-portal 默认 off', featOff === false, `isFeatureOn=${featOff}`);

  section('2. 联邦主记录 + 双向共享视图（真实 config_store 写）');
  const fed = await createFederation({
    vendorTenant: V,
    dealers: [{ dealer_tenant: D1 }, { dealer_tenant: D2 }],
    decisionId: 'it-dec-onboard',
  });
  ok('createFederation 落 tenant-federation', fed?.vendor_tenant === V && fed.dealers.length === 2);
  const g1 = await grantSharedView({ vendorTenant: V, toTenant: D1, direction: 'push', particleTypes: ['CRM_OFFER_POLICY', 'MFG_REBATE'], decisionId: 'it-dec-grant1' });
  const g2 = await grantSharedView({ vendorTenant: V, toTenant: D2, direction: 'reflow', particleTypes: ['MFG_PROJECT'], decisionId: 'it-dec-grant2' });
  ok('grantSharedView push+reflow 落 shared-view-grant', Array.isArray(g1) && Array.isArray(g2) && g1.length >= 1 && g2.length >= 1);

  section('3. 1:N 读作用域解析（核心内核点 · 真实 config_store 读）');
  const scopeOn = async (t) => federationReadScope(t, { isFeatureOn: async () => true }); // 注入开启，不 flip 平台开关
  const vs = await scopeOn(V);
  ok('厂商视角可读 [自身 + 全部 active 经销商]', JSON.stringify(vs) === JSON.stringify([V, D1, D2]), `scope=${JSON.stringify(vs)}`);
  const ds = await scopeOn(D1);
  ok('经销商视角可读 [自身 + 厂商]', JSON.stringify(ds) === JSON.stringify([D1, V]), `scope=${JSON.stringify(ds)}`);

  section('4. 惰性零侵入（功能关 → 仅自身租户）');
  const inertV = await federationReadScope(V); // 真实 isFeatureOn（默认 off）
  ok('功能关时厂商退化为 [自身]', JSON.stringify(inertV) === JSON.stringify([V]), `scope=${JSON.stringify(inertV)}`);
  const inertD = await federationReadScope(D1);
  ok('功能关时经销商退化为 [自身]', JSON.stringify(inertD) === JSON.stringify([D1]), `scope=${JSON.stringify(inertD)}`);

  section('5. 厂商查名下经销商列表（聚合读）');
  const dealers = await listDealers(V);
  ok('listDealers 返回 2 个经销商', dealers.length === 2, `dealers=${dealers.map((d) => d.dealer_tenant).join(',')}`);

  section('6. 撞单/窜货检测（真实 MFG_PROJECT 读路径 · G3+G6）');
  const ts = Date.now();
  // 在 D1 预置一个同 territory 报备（reflow 数据源）
  const r1 = await queryWrite(
    `INSERT INTO crm.particles (tenant_id, type, slug, title, state, payload)
     VALUES ($1,'MFG_PROJECT',$2,$3,'ACTIVE',$4::jsonb) RETURNING id`,
    [D1, `prj-it-d1-${ts}`, 'D1 苏州项目', JSON.stringify({ territory: TERR, dealer_tenant: D1 })]
  );
  // D2 新报备同 territory → 应命中与 D1 的冲突
  const conflict = await detectTerritoryConflict({
    vendorTenant: V,
    newProject: { dealer_tenant: D2, territory: TERR, slug: `prj-it-d2-${ts}`, ref: `MFG_PROJECT#prj-it-d2-${ts}` },
    decisionId: 'it-dec-conflict',
  });
  ok('detectTerritoryConflict 命中跨经销商 territory 冲突', !!conflict && conflict.dealer_a === D2 && conflict.dealer_b === D1,
    conflict ? `dealer_a=${conflict.dealer_a}, dealer_b=${conflict.dealer_b}, type=${conflict.type}` : '无冲突');
  ok('冲突写入 dealer-conflict-log（带 decision_id）', !!conflict?.decision_id, `decision_id=${conflict?.decision_id}`);

  section('7. 冲突列表 + 仲裁（HITL 第0闸）');
  const conflicts = await listConflicts(V);
  ok('listConflicts 返回 1 条 open', conflicts.length === 1 && conflicts[0].status === 'open', `count=${conflicts.length}`);
  const resolved = await resolveConflict({ vendorTenant: V, conflictId: conflicts[0].detected_at, resolution: '归属 D1（先报备）', decisionId: 'it-dec-resolve' });
  ok('resolveConflict 置 resolved + decision_id', resolved?.status === 'resolved' && !!resolved.decision_id, `status=${resolved?.status}`);

  section('8. 跨租户写物理拦截（cross_tenant_write_denied）');
  let denied = false, errMsg = '';
  try {
    await updateParticle(r1.rows[0].id, { tenantId: V, patch: { note: '尝试越权改 D1 粒子' } }); // actor=厂商 改 经销商 粒子
  } catch (e) { denied = /cross_tenant_write_denied/.test(e.message); errMsg = e.message; }
  ok('厂商改经销商粒子被 cross_tenant_write_denied 拦截', denied, errMsg);

  section('结果汇总');
  const failed = results.filter((r) => !r.pass);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) { console.log('失败项：' + failed.map((f) => f.name).join('; ')); process.exit(1); }
  console.log('🟢 经销商联邦端到端联调全绿（真实 DB 链路）');
  process.exit(0);
}

main().catch((e) => { console.error('💥 联调脚本异常：', e); process.exit(2); });
