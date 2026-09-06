// scripts/fix-billing-encoding.mjs
// 用途：修复 billing-plans 中因非 UTF-8 客户端保存导致的乱码（name/quote/features/tag_text）。
// 策略：以 db/seed-billing-config.sql 口径为中文文本真相源，仅当字段出现乱码（? 或 U+FFFD）时才覆盖；
//       价格/权益/数值字段保持当前业务库值不动，避免覆盖用户合法调价。
// 用法：NODE_ENV=development node scripts/fix-billing-encoding.mjs [--dry-run]
import { queryWrite, query } from '../src/db.js';

const TEXT_FIELDS = ['name', 'quote', 'tag_text'];

const SEED_TEXT = {
  free: {
    name: '免费版 · Free',
    quote: '原价：¥99 / 账号（前三月免费）',
    features: ['核心 CRM（客户/商机/合同/报价/回款）'],
    tag_text: '前三月免费',
  },
  starter: {
    name: '成长版 · Starter',
    quote: '¥698 / 账号·月',
    features: ['AI 智能体四件套 + 客户 360 洞察'],
    tag_text: '首月特价',
  },
  pro: {
    name: '增强版 · Pro',
    quote: '¥2980 / 账号·月',
    features: ['决策自治', '事件自动化', '审批流', 'LLM', 'MCP', '高级报表', '审计'],
    tag_text: '热销',
  },
  enterprise: {
    name: '企业版 · Enterprise',
    quote: '¥8800 / 账号·月',
    features: ['行业配置化', '高级 RBAC', '客户记忆', 'SLA'],
    tag_text: '企业首选',
  },
  local_flagship: {
    name: '本地旗舰版 · Local Flagship',
    quote: '面议',
    features: ['私有化本地部署', '全量功能', '数据不出域'],
    tag_text: '',
  },
};

function looksCorrupt(v) {
  if (v == null) return false;
  const s = String(v);
  return s.includes('?') || s.includes('\uFFFD') || s.includes('�');
}

function featuresCorrupt(arr) {
  if (!Array.isArray(arr)) return true;
  return arr.some((s) => looksCorrupt(s));
}

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const row = await query("SELECT value FROM crm.config_store WHERE tenant_id='system' AND key='billing-plans'");
  const plans = Array.isArray(row.rows[0]?.value) ? row.rows[0].value : [];
  let changed = 0;
  const report = [];

  for (const p of plans) {
    const seed = SEED_TEXT[p.plan_id];
    if (!seed) {
      report.push({ plan_id: p.plan_id, note: '无种子模板，跳过' });
      continue;
    }
    const patch = {};
    for (const f of TEXT_FIELDS) {
      if (looksCorrupt(p[f])) {
        patch[f] = seed[f];
      }
    }
    if (featuresCorrupt(p.features)) {
      patch.features = seed.features;
    }
    if (Object.keys(patch).length) {
      Object.assign(p, patch);
      changed++;
      report.push({ plan_id: p.plan_id, patched: Object.keys(patch) });
    } else {
      report.push({ plan_id: p.plan_id, note: '文本正常，无需修复' });
    }
  }

  console.log(JSON.stringify({ dryRun, changed, report }, null, 2));

  if (!dryRun && changed) {
    await queryWrite(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by) VALUES ('system','billing-plans',$1::jsonb,'fix-billing-encoding')
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [JSON.stringify(plans)]
    );
    console.log('已写回业务库。');
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
