// src/page/nlParser.js — NL→Schema 确定性解析（绝不产出 HTML）
// 设计输入：ai-portal-page-generation 三段式；解析映射确定性规则（意图→type/实体→粒子/指标→聚合/阈值→高亮/动作→按钮）
import {
  PAGE_TYPES, COMPONENT_KINDS, PARTICLE_TYPES_ENUM,
  ACTION_WHITELIST, CANONICAL_NAV,
} from './schema.js';

// NL→Schema 解析：返回 {schema, confidence, needsClarification, notes}
// 确定性规则（非 LLM）：意图关键词 → 页面类型；实体词 → 粒子；指标词 → 聚合；阈值短语 → highlight；动作词 → 按钮
export function parseNlToSchema(nl) {
  const text = String(nl || '').trim();
  if (!text) return { schema: null, confidence: 0, needsClarification: true, notes: ['空输入'] };

  const notes = [];

  // 1) 意图 → 页面类型（看板/概览/分布→dashboard；表格/列表/明细→table；表单/录入→form；详情→detail；目标/工作台→workspace）
  let type = 'dashboard';
  if (/(表格|列表|明细)/.test(text)) type = 'table';
  else if (/(表单|录入|新增)/.test(text)) type = 'form';
  else if (/(详情|查看.*信息)/.test(text)) type = 'detail';
  else if (/(目标|工作台|任务|workspace)/i.test(text)) type = 'workspace';

  // 2) 实体 → 粒子（商机/交易/机会→CRM_DEAL；客户→CRM_ACCOUNT；联系人→CRM_CONTACT；人→CRM_PERSON；产品→CRM_PRODUCT；价格→CRM_PRICE_LIST；组织→CRM_ORGANIZATION；知识→CRM_KNOWLEDGE；资料/资产→CRM_UNSTRUCTURED_ASSET）
  let particleType = null;
  const entityMap = [
    [/商机|交易|机会|deal/i, 'CRM_DEAL'],
    [/客户|account/i, 'CRM_ACCOUNT'],
    [/联系|contact/i, 'CRM_CONTACT'],
    [/人员|人|person/i, 'CRM_PERSON'],
    [/产品|product/i, 'CRM_PRODUCT'],
    [/价格|价格表|price/i, 'CRM_PRICE_LIST'],
    [/组织|部门|org/i, 'CRM_ORGANIZATION'],
    [/知识|文档|know/i, 'CRM_KNOWLEDGE'],
    [/资料|资产|unstructured/i, 'CRM_UNSTRUCTURED_ASSET'],
  ];
  for (const [re, type_] of entityMap) {
    if (re.test(text)) { particleType = type_; break; }
  }
  if (!particleType) {
    // 缺实体直接早退——绝不产 dataBinding.particleType=null 的半残 schema
    // （validator 会拒，落到 schema_invalid 不如 parse_empty + needsClarification 语义清晰；
    //   此处 notes 含可读引导，前端可据此给出补全提示而非纯错误。）
    notes.push(
      '实体未识别',
      '已知支持的业务对象：商机｜客户｜联系人｜产品｜价格表｜人员｜组织｜知识｜资料｜报价单｜合同｜订单｜发票｜回款',
      '请在指令中包含业务对象词，例如「展示商机金额」「客户跟踪」「报价单」。',
    );
    return { schema: null, confidence: 0, needsClarification: true, notes };
  }
  notes.push(`实体识别: ${particleType}`);

  // 3) 指标 → 聚合（金额/总量→sum；数量/个数→count；比率/率→avg；最新→latest）
  let agg = null;
  let metricField = null;
  if (/(金额|总量|总额|amount|total)/i.test(text)) { agg = 'sum'; metricField = 'amount'; }
  else if (/(数量|个数|count)/i.test(text)) { agg = 'count'; metricField = null; }
  else if (/(率|占比|avg|平均)/i.test(text)) { agg = 'avg'; metricField = null; }
  else if (/(最新|最近|latest)/i.test(text)) { agg = 'latest'; metricField = null; }

  // 4) 阈值高亮（低于 X%/小于 X% → highlight lt X/100 red；超过/高于 → gt）
  let highlight = null;
  const ltMatch = text.match(/(?:低于|小于)\s?(\d+(?:\.\d+)?)\s?%/);
  const gtMatch = text.match(/(?:高于|超过|大于)\s?(\d+(?:\.\d+)?)\s?%/);
  if (ltMatch) highlight = { when: { field: 'rate', op: 'lt', value: Number(ltMatch[1]) / 100 }, color: 'red' };
  else if (gtMatch) highlight = { when: { field: 'rate', op: 'gt', value: Number(gtMatch[1]) / 100 }, color: 'green' };

  // 5) 动作 → 按钮（审批/推进→crm-deal-advance 仅当实体商机；查看客户→crm-account-360）
  const actions = [];
  if (/(审批|推进|advance)/i.test(text) && particleType === 'CRM_DEAL') {
    actions.push({ label: '推进商机', action: 'crm-deal-advance' });
  }
  if (/(查看客户|360)/i.test(text) && particleType === 'CRM_ACCOUNT') {
    actions.push({ label: '客户跟踪', action: 'crm-account-360' });
  }

  // 6) 置信度：完整(实体+指标+动作)→0.9；有实体缺指标→0.7；缺实体→0.3+needsClarification；注入尝试已在 guardrails 拦截(safe:false)
  let confidence = 0.3;
  let needsClarification = false;
  if (particleType && (agg || highlight)) confidence = 0.7;
  if (particleType && (agg || highlight) && actions.length) confidence = 0.9;
  if (!particleType) needsClarification = true;

  // 7) 组装 schema（受控结构）
  const schema = {
    version: '0.1',
    type,
    title: text.slice(0, 40),
    navigation: { group: type === 'workspace' ? 'workspace' : 'intelligence', to: mapNavFromType(type), icon: '📊' },
    layout: { columns: type === 'table' ? 1 : 2, theme: 'light' },
    components: [
      {
        kind: type === 'table' ? 'table' : 'metric-card',
        title: type === 'table' ? '明细列表' : '指标卡',
        dataBinding: {
          source: 'particle',
          particleType,
          filters: [],
          metrics: agg ? [{ field: metricField || particleType, agg, label: text.slice(0, 12) }] : [],
          columns: type === 'table' ? ['name', 'stage', 'amount'] : undefined,
        },
        ...(highlight ? { style: { highlight } } : {}),
        ...(actions.length ? { actions } : {}),
      },
    ],
  };
  return { schema, confidence, needsClarification, notes };
}

function mapNavFromType(type) {
  if (type === 'workspace') return '/workspace';
  if (type === 'table') return '/deals';
  if (type === 'form') return '/deals';
  if (type === 'detail') return '/accounts';
  return '/dashboard';
}