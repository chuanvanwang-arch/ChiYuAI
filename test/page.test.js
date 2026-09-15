// test/page.test.js — 门户 NL→Page 纯逻辑测试（无 PG 依赖，本地全绿）
// 子系统四：NL→受控 Schema→渲染器（T1-T7 累积 describe 块）
// 设计输入：docs/2026-08-25-portal-page-generation-design.md（§A-§F 已批准）
import { describe, it, expect } from 'vitest';

// ───────────────────────── T1 · schema.js 协议常量 ─────────────────────────
import {
  PAGE_TYPES, COMPONENT_KINDS, THEMES, FILTER_OPS, AGG_FUNCS,
  PARTICLE_TYPES_ENUM, ACTION_WHITELIST, CANONICAL_NAV,
  STATE_FIELDS_PER_TYPE, SNAPSHOT_FIELDS_PER_TYPE,
} from '../src/page/schema.js';

describe('T1 · schema.js 协议常量 + 粒子值域 + Action 白名单', () => {
  it('页面/组件/主题/算子/聚合常量齐备', () => {
    expect(PAGE_TYPES).toContain('dashboard');
    expect(PAGE_TYPES).toContain('workspace');
    expect(COMPONENT_KINDS).toContain('metric-card');
    expect(COMPONENT_KINDS).toContain('table');
    expect(THEMES).toEqual(['light', 'dark']);
    expect(FILTER_OPS).toContain('eq');
    expect(FILTER_OPS).toContain('lt');
    expect(AGG_FUNCS).toEqual(['count', 'sum', 'avg', 'latest']);
  });

  it('粒子值域含 23 真粒子且不含旧值', () => {
    // 15 L2C 业务粒子（schema.js:28-33）+ 8 审批域粒子（CRM_APPROVAL_* 由阶段3 审批引擎扩展）
    expect(PARTICLE_TYPES_ENUM).toHaveLength(23);
    expect(PARTICLE_TYPES_ENUM).toContain('CRM_DEAL');
    expect(PARTICLE_TYPES_ENUM).toContain('CRM_ACCOUNT');
    expect(PARTICLE_TYPES_ENUM).toContain('CRM_UNSTRUCTURED_ASSET');
    // stage3 业务闭环粒子（报价/合同/回款/发票/订单）
    expect(PARTICLE_TYPES_ENUM).toContain('CRM_QUOTATION');
    expect(PARTICLE_TYPES_ENUM).toContain('CRM_CONTRACT');
    expect(PARTICLE_TYPES_ENUM).toContain('CRM_INVOICE');
    expect(PARTICLE_TYPES_ENUM).toContain('CRM_ORDER');
    // 旧值/前缀残缺直接不在值域内（非静默映射）
    expect(PARTICLE_TYPES_ENUM).not.toContain('DEAL');
    expect(PARTICLE_TYPES_ENUM).not.toContain('ACCOUNT');
    expect(PARTICLE_TYPES_ENUM).not.toContain('PURCHASE_ORDER');
  });

  it('Action 白名单对齐子系统三（读全量 + 写白名单）', () => {
    expect(ACTION_WHITELIST.read).toContain('data-particle-read');
    expect(ACTION_WHITELIST.read).toContain('crm-account-360');
    // 写白名单 = 对话式自主写入基础 3 个 + stage3 门户可绑定写 Action（schema.js:31）
    // 基础 3：crm-deal-advance / data-particle-create / data-particle-update
    // + 审批签批 2 个（crm-approval-approve/reject，供待我审批 rowActions 行内按钮）
    // + 线索池退回 1 个（crm-lead-return，T6 场景②：手动退回公海，跳过超期校验）
    expect(ACTION_WHITELIST.write).toEqual([
      'crm-deal-advance', 'data-particle-create', 'data-particle-update',
      'crm-lead-pick', 'crm-lead-recycle', 'crm-lead-return', 'crm-lead-move',
      'crm-payment-plan-create', 'crm-payment-record-create',
      'crm-invoice-reconcile', 'crm-order-advance',
      'crm-approval-approve', 'crm-approval-reject',
      // 参数调优签批（P1 2026-09-05 设计 §2.4，schema.js:58）：my-todo「参数调优」行内按钮
      'crm-tune-approve', 'crm-tune-reject',
    ]);
  });

  it('权威导航 + 状态/快照字段约束表', () => {
    expect(CANONICAL_NAV).toContain('/dashboard');
    expect(CANONICAL_NAV).toContain('/workspace');
    expect(STATE_FIELDS_PER_TYPE.CRM_DEAL).toContain('stage');
    expect(SNAPSHOT_FIELDS_PER_TYPE.CRM_PRODUCT).toContain('qty');
  });
});

// ───────────────────────── T2 · nlParser.js NL→Schema 确定性解析 ─────────────────────────
import { parseNlToSchema } from '../src/page/nlParser.js';

describe('T2 · nlParser.js NL→Schema 确定性解析', () => {
  it('无实体指令 → 早退 schema:null + needsClarification（保留 notes 引导）', () => {
    const r = parseNlToSchema('给我一个看板');
    expect(r.schema).toBeNull();
    expect(r.needsClarification).toBe(true);
    expect(r.confidence).toBe(0);
    expect(Array.isArray(r.notes)).toBe(true);
    expect(r.notes.join(' ')).toMatch(/实体未识别/);
  });

  it('商机实体 + 金额 → CRM_DEAL + sum 聚合 + confidence 0.7', () => {
    const r = parseNlToSchema('给我一个看板，展示商机金额');
    expect(r.schema.components[0].dataBinding.particleType).toBe('CRM_DEAL');
    expect(r.schema.components[0].dataBinding.metrics[0].agg).toBe('sum');
    expect(r.confidence).toBe(0.7);
    expect(r.needsClarification).toBe(false);
  });

  it('低于 90% → highlight red lt 0.9', () => {
    const r = parseNlToSchema('展示客户商机金额，低于 90% 红色标出');
    expect(r.schema.components[0].style.highlight).toEqual({ when: { field: 'rate', op: 'lt', value: 0.9 }, color: 'red' });
  });

  it('表格意图 → table 页型 + 列', () => {
    const r = parseNlToSchema('给我一个商机明细表格');
    expect(r.schema.type).toBe('table');
    expect(r.schema.components[0].kind).toBe('table');
    expect(r.schema.components[0].dataBinding.columns).toEqual(['name', 'stage', 'amount']);
  });

  // 修复（2026-08-30）：parser 必须对"无实体"早退，不再产 dataBinding.particleType=null 的半残 schema
  // 理由：半残 schema 走到 validator 抛「粒子类型非法: null」，错误信号不清晰；
  //   改为 parser 直接 schema:null + needsClarification，前端拿到 parse_empty 走澄清引导。
  it('无实体指令 → 早退 schema:null + needsClarification + 可读 notes', () => {
    const r = parseNlToSchema('对蒙电100台进行报价');
    expect(r.schema).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.needsClarification).toBe(true);
    expect(Array.isArray(r.notes)).toBe(true);
    expect(r.notes.length).toBeGreaterThanOrEqual(2);
    // 必须明确引导用户用业务对象词
    expect(r.notes.join(' ')).toMatch(/实体未识别/);
    expect(r.notes.join(' ')).toMatch(/商机|客户|报价/);
  });

  it('更纯粹的无实体（无数字/无金额）→ 同样早退', () => {
    const r = parseNlToSchema('给我一个不沾任何业务对象的面板');
    expect(r.schema).toBeNull();
    expect(r.needsClarification).toBe(true);
  });
});
// ───────────────────────── T3 · validator.js 4 粒子护栏 + navigation 强制 ─────────────────────────
import { validatePageSchema } from '../src/page/validator.js';

const validSchema = {
  version: '0.1', type: 'dashboard', title: '商机看板',
  navigation: { to: '/dashboard' }, layout: { columns: 2, theme: 'light' },
  components: [{
    kind: 'metric-card', title: '商机数',
    dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '商机数' }] },
  }],
};

describe('T3 · validator.js 4 粒子护栏 + navigation 强制', () => {
  it('合法 dashboard → ok', () => {
    const r = validatePageSchema(validSchema);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('旧粒子值（DEAL/ACCOUNT）直接拒绝，非静默映射', () => {
    const bad = { ...validSchema, components: [{ ...validSchema.components[0], dataBinding: { ...validSchema.components[0].dataBinding, particleType: 'DEAL', metrics: [] } }] };
    const r = validatePageSchema(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('粒子类型非法'))).toBe(true);
  });

  it('状态字段 stage 不可聚合、filter 仅 eq', () => {
    const badAgg = { ...validSchema, components: [{ ...validSchema.components[0], dataBinding: { ...validSchema.components[0].dataBinding, particleType: 'CRM_DEAL', metrics: [{ field: 'stage', agg: 'sum' }] } }] };
    const r = validatePageSchema(badAgg);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('不可聚合'))).toBe(true);

    const badFilter = { ...validSchema, components: [{ ...validSchema.components[0], dataBinding: { ...validSchema.components[0].dataBinding, filters: [{ field: 'stage', op: 'gt', value: 'x' }], metrics: [] } }] };
    const r2 = validatePageSchema(badFilter);
    expect(r2.ok).toBe(false);
    expect(r2.errors.some(e => e.includes('仅支持 eq'))).toBe(true);
  });

  it('存量快照字段仅 latest 聚合（CRM_PRODUCT.qty 不可 sum）', () => {
    const bad = { ...validSchema, components: [{ ...validSchema.components[0], dataBinding: { ...validSchema.components[0].dataBinding, particleType: 'CRM_PRODUCT', metrics: [{ field: 'qty', agg: 'sum' }] } }] };
    const r = validatePageSchema(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('仅支持 latest'))).toBe(true);
  });

  it('非白名单 Action 拒绝', () => {
    const bad = { ...validSchema, components: [{ ...validSchema.components[0], actions: [{ label: 'x', action: 'data-particle-delete' }] }] };
    const r = validatePageSchema(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('不在 Action 白名单'))).toBe(true);
  });

  it('navigation.to 非法 → 拒绝', () => {
    const bad = { ...validSchema, navigation: { to: '/hack' } };
    const r = validatePageSchema(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('navigation.to 非法'))).toBe(true);
  });
});

// ───────────────────────── T4 · guardrails.js 输入层护栏 ─────────────────────────
import { guardNlInput } from '../src/page/guardrails.js';

describe('T4 · guardrails.js 输入层护栏（拦截注入）', () => {
  it('拦截 <script> 注入', () => {
    const r = guardNlInput('给我一个看板<script>alert(1)</script>');
    expect(r.safe).toBe(false);
    expect(r.reason).toContain('script');
  });

  it('拦截 javascript: 伪协议', () => {
    const r = guardNlInput('javascript:alert(1) 商机看板');
    expect(r.safe).toBe(false);
    expect(r.reason).toContain('javascript');
  });

  it('拦截 onerror=/onclick= 事件属性', () => {
    const r = guardNlInput('商机表<img src=x onerror=alert(1)>');
    expect(r.safe).toBe(false);
    // 命中 on\\w+= 或 <img\\s+on 任一模式均可（reason 含 on 或 img）
    expect(r.reason).toMatch(/img|on/);
  });

  it('拦截 eval(', () => {
    const r = guardNlInput('eval(alert(1)) 商机看板');
    expect(r.safe).toBe(false);
    expect(r.reason).toContain('eval');
  });

  it('正常 NL（无注入）→ safe:true', () => {
    const r = guardNlInput('给我一个商机金额看板，低于 90% 红色标出');
    expect(r.safe).toBe(true);
  });

  it('空输入 → safe:false 空输入', () => {
    const r = guardNlInput('   ');
    expect(r.safe).toBe(false);
    expect(r.reason).toContain('空输入');
  });
});

// ───────────────────────── T5 · renderer.js 唯一渲染出口 ─────────────────────────
import { renderPage, escapeHtml } from '../src/page/renderer.js';

describe('T5 · renderer.js 唯一渲染出口（转义/data-action/无script/四态）', () => {
  it('escapeHtml 转义 <>&\"\'', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  it('合法 schema → html 含组件标记 + data-action + 无 <script>', () => {
    const r = renderPage({
      version: '0.1', type: 'dashboard', title: '商机看板',
      navigation: { to: '/dashboard' }, layout: { columns: 2, theme: 'light' },
      components: [{
        kind: 'metric-card', title: '金额', style: { highlight: { when: { field: 'rate', op: 'lt', value: 0.9 }, color: 'red' } },
        dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: 'amount', agg: 'sum', label: '商机总额' }] },
        actions: [{ label: '推进商机', action: 'crm-deal-advance' }],
      }],
    }, { components: { 'metric-card': { value: 1234.5 } } });
    expect(r.warnings).toHaveLength(0);
    expect(r.html).toContain('pg-metric-card');
    expect(r.html).toContain('data-highlight="red"');
    expect(r.html).toContain('data-action="crm-deal-advance"');
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('onclick');
  });

  it('动态值转义：用户内容含 <b> 不注入 HTML', () => {
    const r = renderPage({ version: '0.1', type: 'detail', title: '详情', navigation: { to: '/accounts' }, layout: { columns: 1, theme: 'light' },
      components: [{ kind: 'metric-card', title: '账户名', dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] } }],
    }, { components: { 'metric-card': { value: '<b>客户</b>' } } });
    expect(r.html).toContain('&lt;b&gt;客户&lt;/b&gt;');
    expect(r.html).not.toContain('<b>客户</b>');
  });

  it('非法 schema → html 空 + schema_invalid 告警', () => {
    const r = renderPage({ version: '0.1', type: 'dashboard', title: 'x', navigation: { to: '/hack' }, layout: { columns: 1, theme: 'light' }, components: [] });
    expect(r.html).toBe('');
    expect(r.warnings.some(w => w.includes('schema_invalid'))).toBe(true);
  });

  it('四态：loading/error 态输出状态块', () => {
    const r = renderPage({ version: '0.1', type: 'dashboard', title: '看板', navigation: { to: '/dashboard' }, layout: { columns: 1, theme: 'light' },
      components: [{ kind: 'metric-card', title: 'x', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] } }],
    }, { state: 'error', reason: 'PG 不可达' });
    expect(r.html).toContain('data-state="error"');
    expect(r.html).toContain('PG 不可达');
  });
});

// ───────────────────────── T6 · pageStore.js 页面生命周期 + routes 接线 ─────────────────────────
import { createPageFromNl, listPages, publishPage, revertPage, getPageHtml } from '../src/page/pageStore.js';

describe('T6 · pageStore.js 生命周期（draft→publish→revert，注入拒绝不落库）', () => {
  it('合法 NL → draft 落库 + previewHtml 有值', () => {
    const r = createPageFromNl('给我一个看板展示商机金额');
    expect(r.ok).toBe(true);
    expect(r.schema.type).toBe('dashboard');
    expect(r.previewHtml).toContain('pg-metric-card');
    expect(listPages().some(p => p.page_id === r.page_id && p.status === 'draft')).toBe(true);
  });

  it('注入 NL → safe:false 拒绝，不落库', () => {
    const before = listPages().length;
    const r = createPageFromNl('给我一个看板<script>alert(1)</script>');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('input_guard');
    expect(listPages().length).toBe(before);
  });

  it('publish → published；重复 publish 幂等（不自动覆盖已发布页）', () => {
    const r = createPageFromNl('给我一个商机明细表格');
    const p1 = publishPage(r.page_id);
    expect(p1.status).toBe('published');
    const p2 = publishPage(r.page_id);
    expect(p2.ok).toBe(true);
    expect(p2.idempotent).toBe(true);
    expect(p2.status).toBe('published');
  });

  it('revert → draft；未知 page_id 拒绝', () => {
    const r = createPageFromNl('给我一个客户详情');
    const p = publishPage(r.page_id);
    expect(p.status).toBe('published');
    const rv = revertPage(r.page_id);
    expect(rv.status).toBe('draft');
    expect(revertPage('no-such-id').ok).toBe(false);
  });

  it('getPageHtml → 渲染 HTML（经唯一渲染出口）', () => {
    const r = createPageFromNl('给我一个看板展示商机金额');
    const h = getPageHtml(r.page_id);
    expect(h.ok).toBe(true);
    expect(h.html).toContain('pg-page');
    expect(h.html).not.toContain('<script');
  });

  it('listPages 含 nl/status/confidence 摘要（不含 schema 详情）', () => {
    createPageFromNl('给我一个看板展示商机金额');
    const items = listPages();
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveProperty('nl');
    expect(items[0]).toHaveProperty('status');
    expect(items[0]).toHaveProperty('confidence');
    expect(items[0]).not.toHaveProperty('schema');
  });
});
