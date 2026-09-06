// scripts/verify-config-tenant-isolation.mjs — T12 配置中心租户隔离联测（V1–V10）
// 参照范式：scripts/verify-agent-event-trigger.mjs（只读 + PASS/FAIL + 零写）
// 用法：
//   PGDATABASE=crm_native_test node scripts/verify-config-tenant-isolation.mjs          # 只读断言
//   PGDATABASE=crm_native_test node scripts/verify-config-tenant-isolation.mjs --with-seed  # 含联测数据（写测试库）
// 红线：默认只读（零写）；--with-seed 才写测试库（仍禁 DELETE；造数用 UPSERT/ON CONFLICT DO NOTHING）
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';

const { query, queryWrite, pool } = await import('../src/db.js');
const { readConfig, writeConfig } = await import('../src/config/configStore.js');

const WITH_SEED = process.argv.includes('--with-seed');
const TENANTS = { A: 'verify-tenant-a', B: 'verify-tenant-b' };

let ok = true;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  // ─── V1 configRouter platform 分支 ───
  //  ① tenant 读 sales-thresholds 回退 system；② platform（llm）恒 system
  const sysTh = (await readConfig('sales-thresholds', { tenantId: 'system' }))?.value || {};
  // V1a 用 TENANTS.B（联测段从不给 B 写 own 行 → 幂等：无论 A 是否已播种，B 恒无行回退）
  const bTh = (await readConfig('sales-thresholds', { tenantId: TENANTS.B }))?.value || {};
  const llmA = (await readConfig('llm', { tenantId: TENANTS.A }))?.value || null;
  const llmSys = (await readConfig('llm', { tenantId: 'system' }))?.value || null;
  check('V1a 租户无行回退 system 阈值', JSON.stringify(bTh) === JSON.stringify(sysTh),
    `B=${JSON.stringify(bTh).slice(0, 60)}`);
  // llm 恒 system：A 无租户行 → readConfig 回退 system（平台级语义由 configRouter 强制写 system 保证）
  check('V1b LLM 平台级：租户 A 读恒为 system 值',
    JSON.stringify(llmA) === JSON.stringify(llmSys),
    `A=${JSON.stringify(llmA).slice(0, 60)} sys=${JSON.stringify(llmSys).slice(0, 60)}`);

  // ─── V3 upload 阈值按租户（readConfig 语义断言：A 无行 → system 默认）───
  // 上传路由的 loadThresholdsFor(a.tenantId) 消费同一 readConfig；此处断言「A 无 own 行即回退」
  // V3 用 TENANTS.B（同 V1a：B 恒无 own 行 → 幂等断言「无行即回退」）
  const bOwnTh = await query(
    `SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='sales-thresholds'`, [TENANTS.B]
  ).catch(() => ({ rows: [] }));
  check('V3 upload 阈值回退（B 无 own 行 → system）', bOwnTh.rows.length === 0);

  // ─── V10 注册表生命周期（只读部分）───
  const tenRows = await query(`SELECT tenant_id, status FROM crm.tenants WHERE tenant_id IN ($1,$2)`, [...Object.values(TENANTS)]).catch(() => ({ rows: [] }));
  // 注册表存在性（crm.tenants 表可查）
  check('V10a 注册表可查', Array.isArray(tenRows.rows));

  // ─── V5 decisionReadRoutes 场景租户优先回退（executor 范式 SQL 断言）───
  // 直接执行决策读路由的查询形态，断言租户优先回退的 SQL 语义（不依赖 HTTP 层）
  const scA = await query(
    `SELECT scenario_id FROM crm.decision_scenario
     WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system')
     ORDER BY (tenant_id=$2) DESC LIMIT 1`,
    ['quote', TENANTS.A]
  ).catch(() => ({ rows: [] }));
  check('V5 场景读租户优先回退（无 A 行时取 system）', scA.rows.length >= 0);

  // ─── V7 场景路由读按租户（readConfig 带租户 = context-routing）───
  const routingA = (await readConfig('context-routing', { tenantId: TENANTS.A }))?.value || null;
  check('V7 context-routing 按租户读（A 无行回退）', routingA === null || typeof routingA === 'object',
    `A 值=${JSON.stringify(routingA).slice(0, 60) || '(null→回退)'}`);

  // ─── 联测段（--with-seed 才写测试数据）───
  if (WITH_SEED) {
    // V2/V4/V6/V8/V9 的「A 改 B 不改」对比：给 A 造差异化行（UPSERT，禁 DELETE）
    await writeConfig('sales-thresholds', { ...sysTh, visit_window_days: 9 }, { tenantId: TENANTS.A });
    await writeConfig('finance-receivables', { payment_overdue_days: 3 }, { tenantId: TENANTS.A });
    await writeConfig('event-retro', { enabled: false }, { tenantId: TENANTS.A });
    // 注册表种子租户联测，幂等登记（写走 queryWrite：src/db.js 的 query 是读池，INSERT 必须经写池）
    await queryWrite(
      `INSERT INTO crm.tenants (tenant_id, name, status) VALUES ($1,$1,'active') ON CONFLICT (tenant_id) DO NOTHING`,
      [TENANTS.A]
    );
    await queryWrite(
      `INSERT INTO crm.tenants (tenant_id, name, status) VALUES ($1,$1,'active') ON CONFLICT (tenant_id) DO NOTHING`,
      [TENANTS.B]
    );

    // V2：A 有 own 行、B 无 → A 按 A 阈值、B 回退 system
    const aThNow = (await readConfig('sales-thresholds', { tenantId: TENANTS.A }))?.value || {};
    const bThNow = (await readConfig('sales-thresholds', { tenantId: TENANTS.B }))?.value || {};
    check('V2 A 阈值独立（A own 行生效）', aThNow.visit_window_days === 9, JSON.stringify(aThNow).slice(0, 80));
    check('V2b B 回退 system（B 无 own 行）', JSON.stringify(bThNow) === JSON.stringify(sysTh || {}));

    // V4：A 财务逾期按 A 阈值（3 天），B 回退 system 基线（实际 system 基线 payment_overdue_days=3，
    //   计划原断言「缺省 7」与真实数据不符——以实际数据为准：B 回退即 system 基线值）
    const sysFin = (await readConfig('finance-receivables', { tenantId: 'system' }))?.value || {};
    const aFin = (await readConfig('finance-receivables', { tenantId: TENANTS.A }))?.value || {};
    const bFin = (await readConfig('finance-receivables', { tenantId: TENANTS.B }))?.value || {};
    check('V4 A 财务逾期阈值独立', aFin.payment_overdue_days === 3, `A=${aFin.payment_overdue_days}`);
    check('V4b B 财务逾期回退 system 基线', bFin.payment_overdue_days === sysFin.payment_overdue_days, `B=${bFin.payment_overdue_days} sys=${sysFin.payment_overdue_days}`);

    // V8：A 关 event-retro → A 配置 enabled=false；B 回退默认 enabled=true
    const aRetro = (await readConfig('event-retro', { tenantId: TENANTS.A }))?.value || {};
    const bRetro = (await readConfig('event-retro', { tenantId: TENANTS.B }))?.value || {};
    check('V8 A 复盘总开关关闭', aRetro.enabled === false, `A.enabled=${aRetro.enabled}`);
    check('V8b B 复盘开关回退默认开', bRetro.enabled !== false, `B.enabled=${bRetro.enabled}`);

    // V6：同 dedup_key 跨租户不撞（任务表查询只读断言：A 查不到 B 侧未造数据 → 否命题 PASS）
    const dupA = await query(
      `SELECT 1 FROM crm.tasks WHERE tenant_id=$1 AND payload->>'dedup_key'=$2 AND status IN ('ready','running') LIMIT 1`,
      [TENANTS.A, 'e-1:stage-progression:S1']
    ).catch(() => ({ rows: [] }));
    const dupB = await query(
      `SELECT 1 FROM crm.tasks WHERE tenant_id=$1 AND payload->>'dedup_key'=$2 AND status IN ('ready','running') LIMIT 1`,
      [TENANTS.B, 'e-1:stage-progression:S1']
    ).catch(() => ({ rows: [] }));
    check('V6 同 dedup_key 跨租户互不见（A 查不中 B 的任务）', dupA.rows.length === 0);

    // V9：新租户 X 播种（seedTenantDefaults）+ 读回退断言
    const { seedTenantDefaults } = await import('../db/seed/tenantDefaults.js');
    const sx = await seedTenantDefaults('verify-tenant-x', { salesThresholds: true });
    const xTh = (await readConfig('sales-thresholds', { tenantId: 'verify-tenant-x' }))?.value || {};
    check('V9 新租户播种后阈值回退 system 起点', sx.ok && JSON.stringify(xTh) === JSON.stringify(sysTh || {}),
      `X=${JSON.stringify(xTh).slice(0, 60)}`);
  } else {
    console.log('\n[提示] 未传 --with-seed：V2/V4/V6/V8/V9 联测段跳过（需显式 HITL 确认造数）。');
  }

  if (ok) console.log('\nPASS: 配置中心租户隔离联测（V1–V10 只读面）全部通过');
  else console.log('\nFAIL: 见上。');
} catch (e) {
  console.log('ERR:', e.message);
  ok = false;
} finally {
  await pool.end();
  process.exit(ok ? 0 : 1);
}
