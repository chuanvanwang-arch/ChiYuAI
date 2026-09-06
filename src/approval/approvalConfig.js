// src/approval/approvalConfig.js — 审批业务参数配置层（单一事实源）
//
// 铁律（用户 2026-08-31）：审批业务参数（R1-R4 规则 / 金额档位 / 角色链 / 默认兜底动作）
//   一律后台可配，禁止硬编码在代码里——客户须能按需调整。
//
// 分层职责：
//   config_store['approval-config'] → 客户可调事实源（前端 /approval-config.html 编辑，写经决策第0闸+sysadmin）
//   本模块                   → 读取 / 铺底默认 / 合并 / 运行时兜底；代码只经此入口取审批参数
//   src/approval/ruleResolver.js → 纯函数消费 mergedApprovalConfig，无 DB 依赖（便于单测）
//
// 向后兼容：未传/未配配置时一律回退 DEFAULT_APPROVAL_CONFIG，行为与改造前完全一致。

import { readConfig } from '../config/configStore.js';

/** 兜底默认（与改造前 ruleResolver.js 逐项逐字一致，保证既有行为不变） */
export const DEFAULT_APPROVAL_CONFIG = Object.freeze({
  // R1-R4：业务域、触发 S 边、默认审批角色、说明（设计 §3.1）
  rules: {
    R1: { id: 'R1', business: 'deal',     fromStage: 'S2', toStage: 'S3', baseRole: 'manager',                  description: '商机推进审批（S2→S3）' },
    R2: { id: 'R2', business: 'quote',     fromStage: 'S3', toStage: 'S4', baseRole: 'manager', escalateRole: 'director', description: '报价审批（S3→S4）' },
    R3: { id: 'R3', business: 'contract',  fromStage: 'S4', toStage: 'S5', baseRole: 'legal',   escalateRole: 'vp',       description: '合同审批（S4→S5）' },
    R4: { id: 'R4', business: 'invoice',   fromStage: 'S5', toStage: 'S6', baseRole: 'finance_vp', escalateRole: 'finance_vp', description: '回款/发票审批（S5→S6）' },
  },
  // 分级审批档位金额阈值（§3.3，单位：元；出厂默认，可被 config_store 覆盖）
  tierThresholds: {
    t2: 1_000_000,   // ≥ T2 下限：¥100万
    t3: 5_000_000,   // ≥ T3 下限：¥500万
  },
  // 各规则按档位的审批人链（§3.3：T1 经理单签 / T2 经理+总监 / T3 经理→总监→总裁）
  // R1 仅销售经理（单/会签，无分级）；R4 固定财务VP（超信用→财务VP）。
  tierChains: {
    R1: { T1: ['manager'],                T2: ['manager'],                T3: ['manager'] },
    R2: { T1: ['manager'],                T2: ['manager', 'director'],    T3: ['manager', 'director', 'president'] },
    R3: { T1: ['legal'],                  T2: ['legal', 'vp'],            T3: ['legal', 'vp', 'president'] },
    R4: { T1: ['finance_vp'],             T2: ['finance_vp'],             T3: ['finance_vp'] },
  },
  // 重大项目是否强制最高档 T3（设计 §3.3：T3 = >¥500万 或「重大项目」）
  majorProjectForceT3: true,
  // 审批人为空且无规则时的默认兜底动作（运行态控制，避免引擎硬编码）：
  //   'ASSIGN_ADMIN'（默认，转管理员，安全） / 'AUTO_PASS'（显式声明空即自动过）
  defaultEmptyApproverAction: 'ASSIGN_ADMIN',
});

/** 合并：配置优先、缺失回退默认（深拷贝冻结对象，安全只读访问） */
export function mergedApprovalConfig(cfg) {
  const out = JSON.parse(JSON.stringify(DEFAULT_APPROVAL_CONFIG));
  const src = (cfg && typeof cfg === 'object') ? cfg : {};
  if (src.rules && typeof src.rules === 'object') out.rules = { ...out.rules, ...src.rules };
  if (src.tierThresholds && typeof src.tierThresholds === 'object') out.tierThresholds = { ...out.tierThresholds, ...src.tierThresholds };
  if (src.tierChains && typeof src.tierChains === 'object') out.tierChains = { ...out.tierChains, ...src.tierChains };
  if (typeof src.majorProjectForceT3 === 'boolean') out.majorProjectForceT3 = src.majorProjectForceT3;
  if (typeof src.defaultEmptyApproverAction === 'string') out.defaultEmptyApproverAction = src.defaultEmptyApproverAction;
  return out;
}

/** 运行时读取：从 config_store 读 approval-config，缺失/异常回退默认（不抛，保证既有行为） */
// 2026-09-05 G2：读按租户（readConfig 内部按 autoSeed 落租户行；缺键回退出厂默认，
//   不再回退 system——与 configStore 的「system 只作模板源」语义对齐）。缺省 'system'=平台基线（兼容既有调用）。
export async function readApprovalConfig(tenantId = 'system') {
  try {
    const r = await readConfig('approval-config', { tenantId });
    return mergedApprovalConfig(r?.value);
  } catch {
    return mergedApprovalConfig();
  }
}

// —— 引擎兜底动作（运行态控制，避免引擎硬编码；服务启动时由配置加载设定，运行时可被 config_store 覆盖）——
let _emptyAction = DEFAULT_APPROVAL_CONFIG.defaultEmptyApproverAction;

/** 服务启动加载配置后调用，设定运行态默认兜底动作（不传则保持默认 ASSIGN_ADMIN） */
export function setApprovalControl(cfg) {
  const merged = mergedApprovalConfig(cfg);
  _emptyAction = merged.defaultEmptyApproverAction || 'ASSIGN_ADMIN';
}

/** 读取运行态默认兜底动作（供引擎在「无审批规则」分支使用，取代硬编码字面量） */
export function getDefaultEmptyApproverAction() {
  return _emptyAction || 'ASSIGN_ADMIN';
}
