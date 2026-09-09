// scripts/seed-quote-policy-config.mjs
// 向 config_store 写入报价政策相关配置（system 模板；租户读时由 configStore.autoSeed 克隆）。
import { writeConfig } from '../src/config/configStore.js';

const PRICE_AUTHORITY = {
  default_max_discount_pct: 10,
  roles: {
    sales: { max_discount_pct: 10 },
    presales: { max_discount_pct: 15 },
    manager: { max_discount_pct: 30 },
    director: { max_discount_pct: 100 },
  },
};

const REQUIREMENT_DIMENSIONS = {
  levels: ['MUST', 'SHOULD', 'NICE'],
  dimensions: [
    { dim_key: 'REQ_PRICE_BASELINE', label: '报价基线确认', level: 'MUST' },
    { dim_key: 'REQ_DISCOUNT_AUTHORITY', label: '折扣权限确认', level: 'MUST' },
    { dim_key: 'REQ_WRITTEN_APPROVAL', label: '书面批文', level: 'MUST' },
    { dim_key: 'REQ_BUDGET', label: '预算落实', level: 'SHOULD' },
    { dim_key: 'REQ_TIMELINE', label: '交付时间表', level: 'SHOULD' },
    { dim_key: 'REQ_TRIAL', label: '试用安排', level: 'NICE' },
  ],
};

async function main() {
  await writeConfig('price-authority', PRICE_AUTHORITY, { tenantId: 'system' });
  await writeConfig('requirement-dimensions', REQUIREMENT_DIMENSIONS, { tenantId: 'system' });
  console.log('seeded price-authority + requirement-dimensions');
}

main().catch((e) => { console.error(e); process.exit(1); });
