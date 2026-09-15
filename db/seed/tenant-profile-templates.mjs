// db/seed/tenant-profile-templates.mjs
// 把 7 份行业画像沉淀为 system 模板行（tenant-profile-template-<id>），供运行时「分配画像」克隆。
// 对齐铁律：system 只作模板源，租户=覆盖。决策第0闸由运行时 assign-profile 端点承担，本脚本为一次性部署迁移。
import { pathToFileURL } from 'url';
import { query, queryWrite } from '../../src/db.js';
import { writeConfig } from '../../src/config/configStore.js';
import { seedChemicalProfile } from './tenant-profile-chemical.js';
import { seedTrainingProfile } from './tenant-profile-training.js';
import { seedMeddevProfile } from './tenant-profile-meddev.js';
import { seedInsMediProfile } from './tenant-profile-insmedi.js';
import { seedDemoProfile } from './tenant-profile-demo.js';
import { seedConsultProfile } from './tenant-profile-consult.js';
import { seedConsult2Profile } from './tenant-profile-consult2.js';

const TMP = '__tp_tpl_src__';
const SPECS = [
  ['chemical', '化工', seedChemicalProfile],
  ['training', '培训', seedTrainingProfile],
  ['meddev', '医疗器械', seedMeddevProfile],
  ['insmedi', '仪器医疗', seedInsMediProfile],
  ['demo', '演示', seedDemoProfile],
  ['consult', '企业管理咨询', seedConsultProfile],
  ['consult2', '咨询变体', seedConsult2Profile],
];

export async function seedTenantProfileTemplates() {
  for (const [id, label, fn] of SPECS) {
    await fn(TMP, { withDiscovery: false }); // 各 seed 默认 tenant_id 被参数覆盖；哨兵租户不写 discovery-rules（该脚本末尾仅清 tenant-profile 键 → 写了会残留）
    const { rows } = await query(
      `SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [TMP]);
    if (!rows[0]) { console.warn('跳过（无画像源）:', id); continue; }
    const base = JSON.parse(JSON.stringify(rows[0].value || {}));
    base.meta = { ...(base.meta || {}), template_id: id, industry_label: label, source: 'seed' };
    await writeConfig('tenant-profile-template-' + id, base, { tenantId: 'system', updatedBy: 'admin' });
    console.log('template seeded:', id, label);
  }
  await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [TMP]);
  return { ok: true };
}

const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  seedTenantProfileTemplates()
    .then(() => { console.log('done'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
