// src/approval/ruleResolver.js — 分业务审批规则 R1-R4 + 分级审批 T1/T2/T3 解析（纯函数，无 DB）
//
// 单一事实源：src/approval/approvalConfig.js（DEFAULT_APPROVAL_CONFIG，
//   可被 config_store['approval-config'] 覆盖；前端 /approval-config.html 编辑）。
//   本文件不再硬编码任何业务参数——全部经 mergedApprovalConfig 取得。
//
// 运行态物化由 scripts/seed-approval-rules.mjs 据此落地为 CRM_APPROVAL_* 粒子。
// 说明：crm.approval_flow 已于 2026-08-31 降级为「只读兼容/审计」，运行态事实源为 CRM_APPROVAL_* 粒子。

import { DEFAULT_APPROVAL_CONFIG, mergedApprovalConfig } from './approvalConfig.js';

// 向后兼容导出（测试与脚本直接引用 RULES / DEFAULT_TIER_THRESHOLDS / TIER_CHAINS）
export const RULES = DEFAULT_APPROVAL_CONFIG.rules;
export const DEFAULT_TIER_THRESHOLDS = DEFAULT_APPROVAL_CONFIG.tierThresholds;
const TIER_CHAINS = DEFAULT_APPROVAL_CONFIG.tierChains;

// 解析档位：金额 + 重大项目标记（§3.3：T3 = >¥500万 或「重大项目」）
export function resolveTier(amount = 0, { majorProject = false, thresholds, forceT3 = true } = {}) {
  const th = thresholds || DEFAULT_APPROVAL_CONFIG.tierThresholds;
  if (majorProject && forceT3) return 'T3';                            // 重大项目直接走最高档
  const amt = Number(amount) || 0;
  const t3 = th.t3 ?? 5_000_000;
  const t2 = th.t2 ?? 1_000_000;
  if (amt > t3) return 'T3';                                          // > ¥500万
  if (amt > t2) return 'T2';                                          // ¥100万–500万
  return 'T1';                                                        // ≤ ¥100万
}

// 解析审批链（§3.4 拓扑：START → COND(AI) → APPROVER* → END）
// 返回可物化为 CRM_APPROVAL_* 粒子的结构化拓扑（纯数据，无副作用）。
// config 缺省时回退 DEFAULT_APPROVAL_CONFIG（与改造前行为一致，兼容迁移脚本与单测）。
export function resolveApprovalChain(ruleId, { amount = 0, majorProject = false, config } = {}) {
  const cfg = config ? mergedApprovalConfig(config) : DEFAULT_APPROVAL_CONFIG;
  const rule = cfg.rules[ruleId];
  if (!rule) throw new Error(`未知审批规则: ${ruleId}（合法 R1-R4）`);

  const tier = resolveTier(amount, { majorProject, thresholds: cfg.tierThresholds, forceT3: cfg.majorProjectForceT3 });
  const approverChain = (cfg.tierChains[ruleId] || cfg.tierChains.R1)[tier];

  // AI 判定节点（CONDITION）的升级触发条件：金额超过当前档位下限即 FLAG→进入升级审批。
  const th = cfg.tierThresholds;
  const escThreshold = tier === 'T3' ? (th.t3 ?? 5_000_000)
                     : tier === 'T2' ? (th.t2 ?? 1_000_000)
                     : 0;
  const condition = { field: 'amount', operator: 'GT', value: escThreshold };

  // 拓扑节点（物化用）：START → CONDITION(AI) → APPROVER(chain) → END
  const topology = [
    { node_type: 'START', name: '开始', pos: 0 },
    { node_type: 'CONDITION', name: 'AI自动校验', pos: 1, condition },
    ...approverChain.map((role, i) => ({ node_type: 'APPROVER', name: `审批${i + 1}`, role, pos: 2 + i })),
    { node_type: 'END', name: '结束', pos: 2 + approverChain.length },
  ];

  return {
    ruleId,
    business: rule.business,
    fromStage: rule.fromStage,
    toStage: rule.toStage,
    tier,
    description: rule.description,
    approverChain,        // 人把关链（按档位）
    condition,            // AI 判定节点的升级触发条件（T6 的 C1 据此选分支）
    topology,             // 可物化拓扑
  };
}

export function listRules() {
  return Object.values(DEFAULT_APPROVAL_CONFIG.rules);
}
