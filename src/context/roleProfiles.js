// src/context/roleProfiles.js — 角色上下文 profile 加载（内存缓存 + 幂等 seed）
// 角色 = 上下文配置（七要素 + 数据范围 + 检索配置），config 驱动非硬编码
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';
import { BUSINESS_PARTICLE_TYPES } from './particleTypes.js';

const cache = new Map();

const SEVEN = (core_focus, default_query_pref, l2c_workflow, kpi_baseline, cross_role_collab, permission_boundary, role_subtype) =>
  ({ core_focus, default_query_pref, l2c_workflow, kpi_baseline, cross_role_collab, permission_boundary, role_subtype });

const DEFAULT_RETRIEVAL = { l1: { enabled: true, topk: 5 }, l2: { enabled: true, topk: 5 }, l3: { enabled: true }, l4: { enabled: true } };

// 七类行为习惯（sales 行为导航；对齐 method-behavior-standard 21 条 BH-01~07，只读注入不硬编码规则）
const _BEHAVIORS = ['聪明勤奋(BH-01)', '双管齐下(BH-02)', '知己知彼(BH-03)', '充满信心(BH-04)', '着眼未来(BH-05)', '善用资源(BH-06)', '依照套路(BH-07)'];

export const SEED_PROFILES = [
  { role_tag: 'sales',    seven_elements: SEVEN('个人商机推进', '按 owner 过滤', '线索→商机→报价→合同', '胜率/客单价', '→售前 技术方案', '仅本人商机/客户读写', '大客户销售'),
    behavioral_nav: _BEHAVIORS, data_scope: { model: 'self' }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'manager',  seven_elements: SEVEN('团队达标', '按 org 子树', '商机推进+风险预警', '团队胜率/管道健康', '→财务 回款 / →售前 排期', '团队子树内商机/客户读写', '区域经理'), data_scope: { model: 'org_subtree' }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'exec',     seven_elements: SEVEN('经营全局', '全量', '全 L2C', '营收/回款周期', '全角色', '全量读写', '高管'), data_scope: { model: 'all' }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'finance',  seven_elements: SEVEN('回款健康', '按 domain', '回款/合同', '回款周期/逾期率', '→销售 催收', 'payment/contract/invoice 域读写', '财务专员'), data_scope: { model: 'domain', domain: ['payment', 'contract', 'invoice'] }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'presales', seven_elements: SEVEN('解决方案与技术方案设计', '按 technical domain（商机/技术方案）', '商机→技术方案→报价支撑→赢单', '方案采纳率/技术匹配度/POC通过率/投标命中率', '→销售 商机支持 / →商务 合同技术条款 / →财务 方案成本', 'CRM_DEAL + CRM_TECHNICAL_PROPOSAL 域读写', '售前顾问/解决方案架构师'), data_scope: { model: 'domain', domain: ['CRM_DEAL', 'CRM_TECHNICAL_PROPOSAL'] }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'contract_admin', seven_elements: SEVEN('合同全生命周期', '按 domain', '合同→回款/开票/续约', '合同执行率/到期率', '→财务 回款 / →销售 合同支持', 'contract/invoice 域读写', '商务经理'), data_scope: { model: 'domain', domain: ['contract', 'invoice'] }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'sysadmin', seven_elements: SEVEN('平台运营与租户治理', '全量', '行业初始化→租户新增→用户新增→RBAC', '租户健康/开通数', '→各租户销售团队', '跨租户平台治理读写', '平台管理员'),
    // 2026-09-09 循环导入修复（scope.js ↔ roleProfiles.js TDZ）：BUSINESS_PARTICLE_TYPES 来自 scope.js，
    //   而 scope.js 又 import 本模块的 loadProfile——若 scope.js 先被求值，本行顶层读 BUSINESS_PARTICLE_TYPES
    //   会触发 ReferenceError（server.js 启动即崩，npm run mcp:http 复现）。改为惰性 getter：
    //   形状/可枚举性不变，求值推迟到模块图初始化完成之后。
    get data_scope() { return { model: 'all', write_scope: { model: 'governance', exclude_types: BUSINESS_PARTICLE_TYPES } }; }, retrieval_cfg: DEFAULT_RETRIEVAL },
  { role_tag: 'ten_admin', seven_elements: SEVEN('租户内管理与开通', '本租户', '用户管理+本租户计费/阈值', '租户内用户活跃/席位', '→平台 sysadmin', '仅本租户管理读写', '租户管理员'), data_scope: { model: 'tenant' }, retrieval_cfg: DEFAULT_RETRIEVAL },
];

export async function loadProfile(roleTag) {
  if (cache.has(roleTag)) return cache.get(roleTag);
  const r = await query(
    `SELECT role_tag, seven_elements, data_scope, retrieval_cfg FROM crm.role_context_profile WHERE role_tag=$1`,
    [roleTag]
  );
  if (!r.rows.length) return null;
  const p = r.rows[0];
  cache.set(roleTag, p);
  return p;
}

export async function getAllProfiles() {
  const r = await query(`SELECT role_tag, seven_elements, data_scope, retrieval_cfg FROM crm.role_context_profile ORDER BY role_tag`);
  return r.rows;
}

export async function seedProfiles() {
  for (const p of SEED_PROFILES) {
    await queryWrite(
      `INSERT INTO crm.role_context_profile (role_tag, seven_elements, data_scope, retrieval_cfg)
       SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM crm.role_context_profile WHERE role_tag=$1)`,
      [p.role_tag, JSON.stringify(p.seven_elements), JSON.stringify(p.data_scope), JSON.stringify(p.retrieval_cfg)]
    );
  }
  const r = await query(`SELECT count(*)::int AS n FROM crm.role_context_profile`);
  emit('trace', 'role-profiles-seeded', { n: r.rows[0].n });
  return r.rows[0].n;
}

export function invalidate(roleTag) { cache.delete(roleTag); }
export function clearCache() { cache.clear(); }
