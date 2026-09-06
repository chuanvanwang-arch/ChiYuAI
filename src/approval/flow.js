// src/approval/flow.js — 审批流配置层（六层读写 + 启停），粒子驱动
// 实证（§5bis C9）：flow→version→node[START/APPROVER/CONDITION/DEFAULT/END]→approver→condition→link
// 综合详设 §7 G 组主章：审批流 = 可配置的一等公民（配置本身即粒子，可被 AI 检索/生成/审计）
import { createParticle, getParticle, updateParticle, queryParticles } from '../particles/particleRepo.js';

const TENANT = 'system';

// 合法节点类型（C9 实证：START 起点 / APPROVER 审批 / CONDITION 条件 / DEFAULT 默认 / END 终点）
export const NODE_TYPES = ['START', 'APPROVER', 'CONDITION', 'DEFAULT', 'END'];

export async function createFlow({ name, enabled = true, domain, description = '', stages = [], tenantId = TENANT }) {
  return createParticle('CRM_APPROVAL_FLOW', { name, enabled, domain, description, stages, versions: [] }, { tenantId });
}

export async function createVersion(flow_id, { version_no, nodes = [], tenantId = TENANT }) {
  const v = await createParticle('CRM_APPROVAL_VERSION', { flow_id, version_no, nodes }, { tenantId });
  const flow = await getParticle(flow_id);
  await updateParticle(flow_id, { patch: { ...flow.payload, versions: [...(flow.payload.versions || []), v.id] } });
  return v;
}

export async function addNode(flow_id, { node_type, name, pos, tenantId = TENANT }) {
  if (!NODE_TYPES.includes(node_type)) {
    throw new Error(`未知节点类型: ${node_type}（合法: ${NODE_TYPES.join('/')}）`);
  }
  return createParticle('CRM_APPROVAL_NODE', { flow_id, node_type, name, pos }, { tenantId });
}

export async function addApprover(node_id, {
  approver_type, role, multi_approver_mode = 'ANY',
  empty_approver_action = 'ASSIGN_ADMIN', same_submitter_action = 'ALLOW',
  approver_direction = 'BOTTOM_UP', cc_list = [], field_permissions = {},
  pass_post_config = {}, reject_post_config = {}, tenantId = TENANT,
}) {
  return createParticle('CRM_APPROVAL_APPROVER', {
    node_id, approver_type, role, multi_approver_mode,
    empty_approver_action, same_submitter_action, approver_direction,
    cc_list, field_permissions, pass_post_config, reject_post_config,
  }, { tenantId });
}

export async function addCondition(node_id, { field, operator, value, tenantId = TENANT }) {
  return createParticle('CRM_APPROVAL_CONDITION', { node_id, field, operator, value }, { tenantId });
}

export async function addLink(from_node, to_node, { condition_ref = null, tenantId = TENANT }) {
  return createParticle('CRM_APPROVAL_LINK', { from_node, to_node, condition_ref }, { tenantId });
}

// 取流程完整拓扑：flow + 节点清单（getFlow 语义：可配置的一等公民返回全配置）
export async function getFlow(flow_id, tenantId = TENANT) {
  const flow = await getParticle(flow_id);
  if (!flow) throw new Error(`审批流不存在: ${flow_id}`);
  const nodes = (await queryParticles({ type: 'CRM_APPROVAL_NODE', tenantId }))
    .filter(r => r.payload.flow_id === flow_id);
  return { ...flow, payload: { ...flow.payload, nodes } };
}

// —— 方案 A 接线（2026-08-31）：配置页域字符串 ↔ 运行态粒子对齐 ——
// 配置页 flow_id 即业务域字符串（deal/quote/contract/invoice/order）；
// 运行态引擎按粒子 id 查，故需 getFlowByDomain 解析桥 + writeFlowFromStages 翻译写入。

// 按 domain 反查 FLOW 粒子（返回含 .id 的粒子对象，供运行态解析）
// 过滤 disabled 流（enabled===false 视为软退休，不参与解析）——避免同域新旧流并存时解析二义
// （与引擎 loadFlow 按 enabled 过滤 FLOW 的意图一致；所有调用方均只需 active 流）
export async function getFlowByDomain(domain, tenantId = TENANT) {
  const flows = await queryParticles({ type: 'CRM_APPROVAL_FLOW', tenantId });
  return flows.find((f) => f.payload && f.payload.domain === domain && f.payload.enabled !== false) || null;
}

// 将 system 模板流克隆为某租户自有副本（对齐 configStore autoSeed：system=模板，tenant=覆盖）
// 仅插不删、幂等：写入前先查本租户是否已存在同 domain 流，避免重复克隆。
// 关键：克隆后返回本租户的真实 FLOW 粒子（含 .id / .payload.tenant_id），保证与 getFlowByDomain 返回形状一致，
//   否则调用方（startGradedApproval 取 .id、approvalFlow.getFlow 取 .payload）会拿到 undefined 而崩溃。
async function cloneSystemFlowToTenant(domain, sysFlow, tenantId) {
  const existing = await getFlowByDomain(domain, tenantId);
  if (existing) return existing;
  await writeFlowFromStages({
    flow_id: domain,
    name: sysFlow.payload.name,
    description: sysFlow.payload.description || '',
    stages: Array.isArray(sysFlow.payload.stages) ? sysFlow.payload.stages : [],
    enabled: sysFlow.payload.enabled !== false,
  }, tenantId);
  return getFlowByDomain(domain, tenantId);
}

// 租户级解析桥（提交/配置页共用）：优先取本租户流；本租户缺则懒克隆 system 模板（保证「不同租户可各自分化」）。
// 关键约束：引擎 loadFlow(flow_id, tenantId) 按 tenantId 过滤节点，故解析到的流与其子节点必须同租户——
// 因此用「克隆到本租户」而非「跨租户引用 system 流」，否则节点查不到（loadFlow 租户错配）。
// 仅当 tenantId==='system' 时直接返回 system 流（平台模板自身不克隆）。
export async function getFlowByDomainWithFallback(domain, tenantId = TENANT) {
  if (tenantId && tenantId !== TENANT) {
    const own = await getFlowByDomain(domain, tenantId);
    if (own) return own;
    const sys = await getFlowByDomain(domain, TENANT);
    if (sys) return cloneSystemFlowToTenant(domain, sys, tenantId);
    return null;
  }
  return getFlowByDomain(domain, TENANT);
}

// 配置页 stages 翻译为粒子拓扑（单一事实源、零同步漂移）
// 输入 {flow_id:domain, name, description, stages:[{stage,role,action,auto_allowed}], enabled}
// 写前软停同 domain 旧 FLOW（禁删铁律：仅置 enabled=false + retired_at，NODE/APPROVER/LINK 随 FLOW 失效）
export async function writeFlowFromStages(flow, tenantId = TENANT) {
  const domain = flow.flow_id;
  const stages = Array.isArray(flow.stages) ? flow.stages : [];
  const enabled = flow.enabled !== false;

  // 软停同 domain 全部 enabled 旧 FLOW（禁删铁律：仅置 enabled=false + retired_at；
  // 取首个匹配的 getFlowByDomain 不足以覆盖重复写入留下的多份 enabled 孤儿流，须全量退休保证单一事实源）
  const oldFlows = (await queryParticles({ type: 'CRM_APPROVAL_FLOW', tenantId }))
    .filter((f) => f.payload && f.payload.domain === domain && f.payload.enabled !== false);
  for (const of0 of oldFlows) {
    await updateParticle(of0.id, {
      patch: { ...of0.payload, enabled: false, retired_at: new Date().toISOString() },
    });
  }

  const newFlow = await createFlow({
    name: flow.name,
    enabled,
    domain,
    description: flow.description || '',
    stages,
    tenantId,
  });

  const start = await addNode(newFlow.id, { node_type: 'START', name: '开始', pos: 0, tenantId });
  let prev = start;
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const node = await addNode(newFlow.id, {
      node_type: 'APPROVER',
      name: s.stage != null ? String(s.stage) : `关卡${i + 1}`,
      pos: i + 1,
      tenantId,
    });
    await addApprover(node.id, {
      approver_type: 'ROLE',
      role: s.role,
      empty_approver_action: s.auto_allowed ? 'AUTO_PASS' : 'ASSIGN_ADMIN',
      multi_approver_mode: 'ANY',
      tenantId,
    });
    await addLink(prev.id, node.id, { condition_ref: null, tenantId });
    prev = node;
  }
  const end = await addNode(newFlow.id, { node_type: 'END', name: '结束', pos: stages.length + 1, tenantId });
  await addLink(prev.id, end.id, { condition_ref: null, tenantId });

  return { flow_id: domain, name: flow.name, description: flow.description || '', stages, enabled };
}

// 软停某 domain 审批流（置 enabled=false，禁删铁律）
export async function retireFlow(domain, tenantId = TENANT) {
  const f = await getFlowByDomain(domain, tenantId);
  if (!f) return null;
  return updateParticle(f.id, {
    patch: { ...f.payload, enabled: false, retired_at: new Date().toISOString() },
  });
}