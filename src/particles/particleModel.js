// src/particles/particleModel.js — 9 真粒子定义 + 属性类型有穷集 + 受控谓词
// 设计输入：01 粒子系统设计 §1 收敛清单、§2.2 属性类型、§4 受控谓词

// 9 真粒子（C0-C4 判定收敛）
import { S_STAGES } from '../sales/stageTaxonomy.js';
import { readConfig } from '../config/configStore.js';
export const PARTICLE_TYPES = {
  CRM_DEAL: {
    slug: 'deal', title: '交易',
    identity: ['name'],
    // Task 3（2026-08-27）：state=粒子生命周期（默认 ACTIVE，对齐 db/schema.sql:6）；业务阶段仅存 payload.stage
    // flow=业务六段状态机（lifecycle.js:9 advanceStage 只进不退校验依赖此 flow；state 列与业务阶段解耦）
    states: { current: 'ACTIVE', flow: S_STAGES },
    why: 'stage_change_reason',  // why 层载体（Oleg Product Memory 门槛）
  },
  CRM_ACCOUNT: {
    slug: 'account', title: '客户',
    identity: ['name'],
    states: { current: 'potential', flow: ['potential','active','dormant','lost'] },
    why: 'dormant_reason',
    coreAttributes: {
      name: 'text', industry: 'select', region: 'select', business_title: 'text',
      source: 'select', size: 'select', rating: 'rating',
      // ATTIO A 桶 firmographics（2026-08-25 借鉴，见 11 增量设计 §3.1）
      domains: 'domain', funding_raised_usd: 'currency', foundation_date: 'date',
      estimated_arr_usd: 'select', employee_range: 'select', categories: 'select',
      logo_url: 'url', linkedin: 'url', twitter: 'url', facebook: 'url',
      instagram: 'url', angellist: 'url',
      // ATTIO D 桶 关系强度（§3.3）
      champion_strength: 'select', key_contact: 'actor-reference',
    },
  },
  CRM_CONTACT: {
    slug: 'contact', title: '联系人',
    identity: ['name'],
    states: { current: 'active', flow: ['active','departed'] },
    coreAttributes: {
      name: 'personal-name', email: 'email-address', phone: 'phone-number',
      title: 'text', department: 'select', decision_power: 'select',
      // ATTIO B 桶 enrichment（§3.2）
      job_title: 'text', avatar_url: 'url', primary_location: 'location',
      linkedin: 'url', twitter: 'url', company: 'record-reference',
      // ATTIO D 桶 关系强度（§3.3）
      relationship_strength: 'select',
    },
  },
  CRM_PRODUCT: {
    slug: 'product', title: '产品',
    identity: ['name'],
    states: { current: 'on_sale', flow: ['on_sale','discontinued'] },
    why: 'price_change_reason',
    // P0 业务主数据门户（2026-08-28 实施计划）：补维护面属性（category 品类；模型此前无 coreAttributes）
    coreAttributes: {
      name: 'text', unit: 'text', category: 'select', list_price: 'currency', status: 'select',
    },
  },
  CRM_PRICE_LIST: {
    slug: 'price-list', title: '价格表',
    identity: ['name'],
    states: { current: 'draft', flow: ['draft','active','expired'] },
    why: 'price_change_reason',
    coreAttributes: {
      name: 'text', valid_from: 'date', valid_to: 'date', permission: 'select',
      products: 'multi-select', change_log: 'text',
    },
  },
  CRM_PERSON: {
    slug: 'person', title: '员工/操作人',
    identity: ['name'],
    states: { current: 'active', flow: ['active','disabled','departed'] },
  },
  CRM_ORGANIZATION: {
    slug: 'organization', title: '组织',
    identity: ['name'],
    states: { current: 'enabled', flow: ['enabled','disabled'] },
    why: 'pool_rule_reason',
  },
  CRM_KNOWLEDGE: {
    slug: 'knowledge', title: '知识/词表',
    identity: ['term'],
    states: { current: 'registered', flow: ['registered','deprecated'] },
    // P0-② 领域 Know-How（docs/2026-09-03-tenant-knowledge-design.md §4）：
    // kind ∈ {icp, competitors, objections, buyer_language}（类目配置化，禁硬编码于逻辑散点）
    coreAttributes: {
      term: 'text',           // 标题/检索锚点（identity 同源）
      kind: 'text',           // icp | competitors | objections | buyer_language
      content: 'text',        // 知识正文
      source: 'text',         // manual | retro_win | retro_lose | import
      confidence: 'number',   // 0-1，人工录入默认 1，复盘回写取决策 confidence
      tags: 'text',           // 可选检索标签（JSON 数组字面量）
    },
  },
  CRM_UNSTRUCTURED_ASSET: {
    slug: 'asset', title: '非结构化证据',
    identity: ['type','file_name'],
    states: { current: 'uploaded', flow: ['uploaded','archived'] },
    // 非结构化文档挂接（设计 docs/2026-08-31-unstructured-asset-attach-design.md §2）
    // 本体只存元数据，字节流落本地磁盘（storage:'local' 抽象前缀，未来扩 s3 只加 adapter）
    coreAttributes: {
      file_name: 'text',   // identity 显式声明（原文件名，落盘时做安全过滤）
      mime: 'select',      // application/pdf / image/jpeg 等
      size: 'number',      // 字节
      sha256: 'text',      // 去重锚点 + 完整性校验（幂等上传依赖）
      storage: 'select',   // 'local'（抽象前缀）
      doc_summary: 'text', // 上传者一句话摘要（B 阶段换 AI 生成）
      source: 'select',    // upload / email / scan
    },
  },
  // —— 阶段 3 业务闭环粒子（综合详设 §8 阶段3；L2C 脊柱 §6.13.11）——
  CRM_QUOTATION: {
    slug: 'quotation', title: '报价单',
    identity: ['name'],
    states: { current: 'draft', flow: ['draft','submitted','approved','rejected','invalid'] },
    why: 'quote_reason',
    coreAttributes: {
      name: 'text', deal_id: 'record-reference', valid_until: 'date',
      amount: 'currency', items: 'text',  // items: [{product_id,qty,unit_price,discount,tax}]
      approval_status: 'select', invalid: 'boolean',
    },
  },
  CRM_CONTRACT: {
    slug: 'contract', title: '合同',
    identity: ['contract_no'],
    states: { current: 'draft', flow: ['draft','submitted','approved','rejected','effective','expired'] },
    why: 'contract_reason',
    coreAttributes: {
      contract_no: 'text', deal_id: 'record-reference', quotation_id: 'record-reference',
      amount: 'currency', start_date: 'date', end_date: 'date', approval_status: 'select',
    },
  },
  CRM_PAYMENT_PLAN: {
    slug: 'payment-plan', title: '回款计划',
    identity: ['contract_id','plan_seq'],
    states: { current: 'pending', flow: ['pending','partial','done'] },
    coreAttributes: {
      contract_id: 'record-reference', plan_amount: 'currency', plan_end: 'date', plan_status: 'select',
    },
  },
  CRM_PAYMENT_RECORD: {
    slug: 'payment-record', title: '回款记录',
    identity: ['contract_id','paid_seq'],
    states: { current: 'recorded', flow: ['recorded'] },
    coreAttributes: {
      contract_id: 'record-reference', paid_amount: 'currency', paid_at: 'timestamp', voucher: 'url',
    },
  },
  CRM_INVOICE: {
    slug: 'invoice', title: '发票',
    identity: ['invoice_no'],
    states: { current: 'open', flow: ['open','reconciled'] },
    coreAttributes: {
      invoice_no: 'text', invoice_type: 'select', invoice_amount: 'currency',
      invoice_date: 'date', contract_id: 'record-reference', reconcile_status: 'select',
    },
  },
  CRM_ORDER: {
    slug: 'order', title: '订单',
    identity: ['order_no'],
    states: { current: 'draft', flow: ['draft','confirmed','shipped','completed'] },
    coreAttributes: {
      order_no: 'text', deal_id: 'record-reference', contract_id: 'record-reference',
      amount: 'currency', status: 'select',
    },
  },
  // —— 业务主数据门户粒子（P0，2026-08-28 实施计划）——
  CRM_OFFER_POLICY: {
    slug: 'offer-policy', title: '报价商务规则包',
    identity: ['name'],
    states: { current: 'draft', flow: ['draft', 'active', 'expired'] },
    why: 'policy_change_reason',
    coreAttributes: {
      name: 'text', subtype: 'select', cost_structure: 'text', price_bands: 'text',
      discount_conditions: 'text', margin_redline: 'currency', tier_discount: 'text',
      change_billing: 'text', valid_from: 'date', valid_to: 'date',
      // 回款政策形态（subtype=payment）：账期天数/催收分级/预付比例
      payment_term: 'number', collection_tier: 'select', prepay_ratio: 'percent',
    },
  },
  CRM_DICT_ENTRY: {
    slug: 'dict-entry', title: '字典值域',
    identity: ['dict_key', 'dict_value'],
    states: { current: 'registered', flow: ['registered', 'deprecated'] },
    coreAttributes: {
      dict_key: 'select', dict_value: 'text', sort_order: 'number', active: 'boolean',
    },
  },
  CRM_COMPETITOR: {
    slug: 'competitor', title: '竞争情报',
    identity: ['name'],
    states: { current: 'active', flow: ['active', 'deprecated'] },
    coreAttributes: {
      name: 'text', solution: 'text', price_quote: 'currency',
      strength: 'text', weakness: 'text', source: 'text',
    },
  },
  CRM_RESOURCE_CALENDAR: {
    slug: 'resource-calendar', title: '交付产能',
    identity: ['name'],
    states: { current: 'draft', flow: ['draft', 'active', 'expired'] },
    coreAttributes: {
      name: 'text', resource_type: 'select', capacity_day: 'number',
      booked_day: 'number', start: 'date', end: 'date',
    },
  },
  // —— 售前域（T3 售前能力：技术方案粒子，挂 DEAL 的 has_technical_proposal 受控边）——
  CRM_TECHNICAL_PROPOSAL: {
    slug: 'technical-proposal', title: '技术方案',
    identity: ['title'],
    states: { current: 'draft', flow: ['draft','submitted','approved','rejected','invalid'] },
    why: 'proposal_reason',
    coreAttributes: {
      title: 'text', content: 'text', solution_type: 'select',
      owner_id: 'record-reference', deal_id: 'record-reference',
    },
  },
  // —— 审批域六层粒子 + 运行态（综合详设 §7 G 组主章；粒子底座承载，无独立表）——
  CRM_APPROVAL_FLOW: {
    slug: 'approval-flow', title: '审批流',
    identity: ['name'],
    states: { current: 'enabled', flow: ['enabled','disabled'] },
  },
  CRM_APPROVAL_VERSION: {
    slug: 'approval-version', title: '审批流版本',
    identity: ['flow_id','version_no'],
    states: { current: 'current', flow: ['current','superseded'] },
    // 类型必须显式声明：identity 兜底对未声明类型的键一律退化为 text（metaAttrModel.js:53），
    // 会把版本号归一成字符串 → identity 指纹（stable_key）漂移 + 版本比较/排序语义错误。
    // 声明后走 coreAttributes 路径（recordFor）：attr_type 精确、enabled=true、required=false。
    coreAttributes: { flow_id: 'text', version_no: 'number' },
  },
  CRM_APPROVAL_NODE: {
    slug: 'approval-node', title: '审批节点',
    identity: ['flow_id','name'],
    states: { current: 'active', flow: ['active','disabled'] },
  },
  CRM_APPROVAL_APPROVER: {
    slug: 'approval-approver', title: '节点审批人规则',
    identity: ['node_id'],
    states: { current: 'active', flow: ['active','disabled'] },
  },
  CRM_APPROVAL_CONDITION: {
    slug: 'approval-condition', title: '节点条件',
    identity: ['node_id','field'],
    states: { current: 'active', flow: ['active','disabled'] },
  },
  CRM_APPROVAL_LINK: {
    slug: 'approval-link', title: '节点连线',
    identity: ['from_node','to_node'],
    states: { current: 'active', flow: ['active','disabled'] },
  },
  CRM_APPROVAL_INSTANCE: {
    slug: 'approval-instance', title: '审批实例',
    identity: ['business_type','business_id'],
    states: { current: 'pending_submit', flow: ['pending_submit','approving','approved','rejected','canceled'] },
  },
  CRM_APPROVAL_TASK: {
    slug: 'approval-task', title: '审批任务',
    identity: ['instance_id','approver'],
    states: { current: 'todo', flow: ['todo','approved','rejected','transferred'] },
  },
  // —— 方法论证据域（阶段 C / F5 修复，设计 docs/2026-09-02-lightfield-memory-decision-study.md §11）——
  // 为什么独立粒子而非给 CRM_DEAL 加 14 个字段：方法论（BANT/MEDDICC/OPP_MATRIX…）可增删改配置，
  //   证据落粒子则「换方法论不动 schema」；且每条证据自带 source/evidence_ref → 可回答
  //   「为什么判定 B(预算) 达标」而不是只留一个孤零零的 true。
  // 版本化 identity（含 version_no）：证据纠偏走**新版本追加**而非原地改，
  //   对齐零 DELETE 铁律与 Lightfield「field value history」——历史断言必须可回溯。
  //   读取侧只认 version_no 最大且 state='asserted' 的那条（见 methodologyEvidence.js）。
  // version_no/met 必须显式声明类型：identity 兜底对未声明键一律退化 text（metaAttrModel.js:53），
  //   会把版本号归一成字符串 → stable_key 漂移 + 版本排序语义错误（CRM_APPROVAL_VERSION 同款教训）。
  CRM_METHODOLOGY_EVIDENCE: {
    slug: 'methodology-evidence', title: '方法论维度证据',
    identity: ['subject_id', 'methodology_id', 'dim_key', 'version_no'],
    states: { current: 'asserted', flow: ['asserted', 'superseded', 'refuted'] },
    why: 'evidence_reason',
    coreAttributes: {
      subject_id: 'record-reference',   // 证据主体（通常 CRM_DEAL id）
      methodology_id: 'text',           // BANT / MEDDICC / OPP_MATRIX …
      dim_key: 'text',                  // A/B/N/T、M/E/D1/D2/I/C1/C2 …
      version_no: 'number',
      met: 'boolean',                   // 该维是否达标（null=未采集，不落此粒子）
      value: 'text',                    // 原始取值/摘要（如「预算 80 万已过会」）
      source: 'select',                 // manual（人工录入，优先）/ auto（提取器）/ enrich
      evidence_ref: 'text',             // 出处：memory_log id / 粒子 id / URL
      asserted_by: 'actor-reference',
      asserted_at: 'timestamp',
      evidence_reason: 'text',
    },
  },
};

// ATTIO 分层语义约定（12 设计 §5/§7：按 tag 路由四层，避免逐字段硬编码）
export const SEMANTIC_TAGS = {
  firmographic: ['domains','funding_raised_usd','foundation_date','estimated_arr_usd','employee_range','categories'],
  social: ['linkedin','twitter','facebook','instagram','angellist'],
  relation: ['champion_strength','key_contact','relationship_strength','company'],
  interaction: ['interaction_index'],
  ui: ['logo_url','avatar_url','primary_location'],
  legacy: ['name','industry','region','source','size','rating','business_title','job_title','title','department','decision_power','email','phone','type'],
};

// 语义标签归属判定（T6 测试消费；未命中 → legacy）
export function semanticTagOf(attr) {
  for (const [tag, attrs] of Object.entries(SEMANTIC_TAGS)) {
    if (attrs.includes(attr)) return tag;
  }
  return 'legacy';
}

// 19 种属性类型有穷集（01 粒子系统设计 §2.2）
export const ATTRIBUTE_TYPE_SET = new Set([
  'text','personal-name','email-address','phone-number','domain','location',
  'number','currency','percent','date','timestamp','select','multi-select',
  'boolean','rating','url','record-reference','actor-reference','interaction',
]);

// 受控谓词表（01 §4；拒绝裸外键）
export const CONTROLLED_PREDICATES = [
  'belongs_to','owned_by','part_of','has_employee','works_at','priced_by',
  'used_in','referenced_in','evidenced_by','sourcedFrom','transitionedBecause',
  'instanceOf','explains','member_of','governs','temporallyFollows',
  'has_technical_proposal',                       // DEAL → TECHNICAL_PROPOSAL（售前技术方案）
  'key_contact',                                  // ACCOUNT → CONTACT（ATTIO 关系强度，见 11 增量设计 §3.3）
  'auto_weak',                                    // 身份解析弱边（12 设计 §7.1，可人工确认升强）
  'relationship_strength',                        // 关系强度边（12 设计 §7.3：决策单元子图 strength 承载）
  'named_assignment',                             // ACCOUNT 分配审计边（指名客户管理，设计 2026-08-30）——写必须经决策第0闸
];

// 校验粒子类型合法
export function isParticleType(type) {
  return Object.prototype.hasOwnProperty.call(PARTICLE_TYPES, type);
}

// —— 多行业配置化（P2/G1，2026-09-03）：双源类型解析器 ——
// 加法收敛（非删除式重构）：保留 PARTICLE_TYPES 33 个 CRM 字面量（不破坏 21 处 CRM 硬编码分支），
// 以「代码基线 ∪ 租户 tenant-profile 配置」双源承接 custom 行业对象，实现零行业专属代码。
// 返回 { source:'code'|'config', ...def, type } 或 null（未知类型）。
// ⚠ readConfig 返回 { value, decision_id }（value 为配置 JSON），须读 profile.value.prototypes。
export async function resolvePrototype(type, tenantId = 'system') {
  if (Object.prototype.hasOwnProperty.call(PARTICLE_TYPES, type)) {
    return { source: 'code', ...PARTICLE_TYPES[type], type };
  }
  if (tenantId && tenantId !== 'system') {
    const profile = await readConfig('tenant-profile', { tenantId }).catch(() => null);
    const proto = profile?.value?.prototypes?.[type];
    if (proto) return { source: 'config', ...proto, type };
  }
  return null;
}

// 同步判断：仅查代码基线（保留 isParticleType 语义，CRM 行为零破坏）
export function isConfigurablePrototype(type) {
  return !Object.prototype.hasOwnProperty.call(PARTICLE_TYPES, type);
}

// 校验谓词是否受控
export function isControlledPredicate(edgeType) {
  return CONTROLLED_PREDICATES.includes(edgeType);
}

// 多行业配置化（P3/G3/G4）：受控谓词 = 基线 CONTROLLED_PREDICATES ∪ 租户 tenant-profile.prototypes[].edgeTypes
// 行业自有关系（如培训机构 supplies 培训项目）零代码声明，其它租户天然不可见。
export async function isControlledPredicateConfig(edgeType, tenantId = 'system') {
  if (CONTROLLED_PREDICATES.includes(edgeType)) return true;
  if (tenantId && tenantId !== 'system') {
    const profile = await readConfig('tenant-profile', { tenantId }).catch(() => null);
    const edgeTypes = profile?.value?.prototypes
      ? Object.values(profile.value.prototypes).flatMap((p) => p.edgeTypes || [])
      : [];
    return edgeTypes.includes(edgeType);
  }
  return false;
}

// 校验所有粒子 coreAttributes 类型 ∈ 19 类型集（ATTIO 借鉴纪律闸门，见 11 增量设计）
export function validateCoreAttributesSchema() {
  for (const [type, def] of Object.entries(PARTICLE_TYPES)) {
    for (const [slug, t] of Object.entries(def.coreAttributes || {})) {
      if (!ATTRIBUTE_TYPE_SET.has(t)) {
        throw new Error(`粒子 ${type} 属性 ${slug} 类型 ${t} 不在 19 类型集内`);
      }
    }
  }
  return true;
}
