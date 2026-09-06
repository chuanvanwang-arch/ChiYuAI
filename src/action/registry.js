// src/action/registry.js — Action 表面注册表
// 设计输入：01 粒子设计 §8（绝不为每个粒子开 CRUD 与谓词开 Action）
// 平台 substrate：data.particle.* ；跨粒子能力：crm.* (01 §8 R2/R5)
const actions = new Map();

export function registerAction(def) {
  // def: { name, kind: 'read'|'write', permission, handler, schema,
  //        namespace?, agentTool?, needsApproval?, force?, version?, owner?,
  //        parameters?, confirm?, rbac_roles?,
  //        mcpExpose?: boolean  // 2026-09-04：data-* substrate 写族默认不上 MCP，
  //          仅本值为 true 时单点 opt-in 放开（tools.js 暴露层判据；首个= data-particle-create）
  //        decisionScenario?: string  // 2026-09-04：MCP 写通道无 decision_id 时，gateway 据此
  //          mint 决策（第 0 闸锚定落点）；未声明的写 Action 维持「无决策不写」DECISION_NEEDED
  //        lifecycle?: 'active'|'engine'|'reserved'  // 2026-09-03 C 方案接线：
  //          active(默认)=运行系统真实调用；engine=审批流/校准/决策/agent/method 引擎内部触发；
  //          reserved=注册暴露但暂未接线（死表面降级，遵守禁 DELETE 铁律不物理删） }
  // 横切属性（R4/R6）：namespace 缺省从 name 前缀推导（crm-deal-advance → crm）
  const full = { ...def };
  if (!full.namespace) full.namespace = String(def.name).split('-')[0];
  actions.set(def.name, full);
}

export function getAction(name) {
  return actions.get(name) || null;
}

// 命名空间分层（R2/R3）：去重命名空间清单
export function listNamespaces() {
  return [...new Set([...actions.values()].map(a => a.namespace))];
}

export function listActions({ kind, namespace } = {}) {
  return [...actions.values()].filter(a =>
    (!kind || a.kind === kind) && (!namespace || a.namespace === namespace));
}

// 测试/重建专用：清空注册表（生产不调用；Map 无 unregister，重置需显式 clear）
export function resetRegistry() {
  actions.clear();
}

// 反爆炸护栏（R3-RED 机检，实践心得 4）：检测「CRUD 爆炸」——不是单 Action 形态，而是系统性模式
// 两种爆炸源（判定语义，非单条名称形态）：
//  ① substrate 层（data.* 命名空间）出现任何 per-type CRUD：data-deal-create → 应折叠为
//     data-particle-create({type})，data 层已有通用入口，per-type 即爆炸。
//  ② 业务命名空间（crm.* 等）同一 concrete type 出现 ≥2 个 CRUD 动词（create/read/update/delete
//     全家桶起步）：crm-quote-create+update+delete → 应折叠为领域动词 Action（crm-quote-submit）。
//     —— 业务域**单个意图** Action（如 crm-quote-create：新建报价）是 C12 域一等能力，合法；
//        只有「同 type 成组出现多个 CRUD 动词」才构成爆炸。
// 豁免：通用 substrate 词（particle/graph/edge/asset/connector/ontology 等）与复合通用词
// （data-particle-edge-create 的 type=particle-edge 是 substrate 通用能力）；审批配置/实例/任务
// （approval-flow/instance/task）是配置资源；deal-timeline 等子图聚合查询（读）非 CRUD。
const CRUD_VERBS = ['create', 'read', 'update', 'delete'];
const GENERIC_TYPES = new Set(['particle', 'graph', 'edge', 'asset', 'connector', 'middleware', 'ontology',
                               'particle-edge', 'graph-edge', 'particle-vertex', 'graph-vertex',
                               'approval-flow', 'approval-instance', 'approval-task',
                               'deal-timeline', 'account-members', 'contact-siblings']);
export function detectCrudExplosion() {
  // 第一步：聚合 per-type CRUD 到 `namespace:type → verb 集合`
  const perTypeVerbs = new Map();
  for (const a of actions.values()) {
    const parts = a.name.split('-');
    if (parts.length >= 3 && CRUD_VERBS.includes(parts[parts.length - 1])) {
      const type = parts.slice(1, -1).join('-');
      if (type && !GENERIC_TYPES.has(type) && !parts.includes('particle')) {
        const ns = a.namespace || parts[0];
        const key = `${ns}:${type}`;
        if (!perTypeVerbs.has(key)) perTypeVerbs.set(key, new Set());
        perTypeVerbs.get(key).add(parts[parts.length - 1]);
      }
    }
  }
  // 第二步：按爆炸语义判定并回收集 offending Action 名
  const offenders = [];
  for (const [key, verbs] of perTypeVerbs) {
    const [ns] = key.split(':');
    if (ns === 'data' || verbs.size >= 2) {   // ①substrate per-type；②业务同 type 全家桶
      for (const a of actions.values()) {
        const parts = a.name.split('-');
        if (parts.length >= 3 && CRUD_VERBS.includes(parts[parts.length - 1])) {
          const type = parts.slice(1, -1).join('-');
          if (type && !GENERIC_TYPES.has(type) && !parts.includes('particle')) {
            const aNs = a.namespace || parts[0];
            if (`${aNs}:${type}` === key) offenders.push(a.name);
          }
        }
      }
    }
  }
  return { exploded: offenders.length > 0, offenders };
}
