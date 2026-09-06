// scripts/seed-tenant-demo.mjs — 演示租户 + 用户 + 业务 + 配置覆盖（幂等；禁删铁律：仅 INSERT/UPSERT）
// 运行：PGDATABASE=crm_native_test node scripts/seed-tenant-demo.mjs
import { query, queryWrite } from '../src/db.js';
import { createParticle } from '../src/particles/particleRepo.js';
import { writeConfig } from '../src/config/configStore.js';

const TENANT = 'acme';
const ADMIN = 'acme_admin';
const PASS = 'acme_secret_123';

async function main() {
  // 1) 租户 admin 用户（幂等）
  const u = await query(`SELECT 1 FROM crm.crm_users WHERE username=$1`, [ADMIN]);
  if (!u.rows.length) {
    const pw = await query(`SELECT crypt($1, gen_salt('bf')) AS h`, [PASS]);
    await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id)
       VALUES ($1,$2,'admin',$3,$4)`,
      [ADMIN, pw.rows[0].h, ADMIN, TENANT]
    );
    console.log(`  + 用户 ${ADMIN} (tenant=${TENANT}) 已建`);
  } else {
    console.log(`  = 用户 ${ADMIN} 已存在，跳过`);
  }

  // 2) 1 条 CRM_ACCOUNT（tenant=acme，幂等）
  const acc = await query(
    `SELECT 1 FROM particles WHERE tenant_id=$1 AND type=$2 AND payload->>'name'=$3`,
    [TENANT, 'CRM_ACCOUNT', 'AcmeCo (demo)']
  );
  if (!acc.rows.length) {
    const p = await createParticle('CRM_ACCOUNT',
      { name: 'AcmeCo (demo)', slug: 'acme-demo-co', industry: 'SaaS', stage: 'lead' },
      { tenantId: TENANT, actor: ADMIN });
    console.log(`  + 账户 ${p.id} (tenant=${TENANT}) 已建`);
  } else {
    console.log(`  = 账户 AcmeCo (demo) 已存在，跳过`);
  }

  // 3) 1 条配置覆盖（tenant=acme 的 sales-thresholds，回退前独立生效，不污染 system）
  const override = { bantcc_pass: 5, note: 'acme 演示租户覆盖值' };
  await writeConfig('sales-thresholds', override, { tenantId: TENANT, updatedBy: 'seed-demo' });
  console.log(`  + 配置覆盖 sales-thresholds (tenant=${TENANT}) 已写`);

  console.log(`\n[seed-tenant-demo] 完成：登录 ${ADMIN} / ${PASS}（tenant=${TENANT}）`);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
