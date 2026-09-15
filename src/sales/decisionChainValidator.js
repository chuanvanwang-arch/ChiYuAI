// src/sales/decisionChainValidator.js — P0-2 决策链角色漂移校验（设计 docs/2026-09-15-anysite-borrowing-analysis.md §3 P0-2）
// 案例依据 F2：ready-to-send 质量闸「无角色漂移」；案例1 180 条 0 漂移。
// 铁律：
//   ① 纯函数、零 DB、零副作用（单测友好）
//   ② 映射词表 / 角色模板 100% 配置驱动（config_store['decision-chain-template']，缺省用 DEFAULT_*）
//   ③ fail-open：未知角色 / 无模板 → 不误报；空联系人 → 完整性 0（fail-closed，不伪绿）
//   ④ 不新增粒子、不改业务域模型（§10 硬约束）
export const DEFAULT_ROLE_TEMPLATE = Object.freeze({
  required: ['veto', 'budget', 'approve'],
  champion: { required: false },
});

// 角色映射词表（title/department/job_title → 角色能力域）
// 注意：为多行业通用，不绑定具体行业字面量（无行业/租户字面量铁律）
export const DEFAULT_ROLE_MAP = Object.freeze([
  { role: 'budget', keywords: ['总经理', '总裁', '副总', '财务', 'CFO', 'CEO'] },
  { role: 'approve', keywords: ['总经理', '总裁', '副总', 'CXO', 'CIO'] },
  { role: 'veto', keywords: ['采购', '法务', '合规', '生产', 'quality', '审计'] },
  { role: 'recommend', keywords: ['研发', '技术', 'IT', '工程师', '产品'] },
  { role: 'champion', keywords: ['研发', '产品', '技术', '市场'] },
]);

// 纯函数：根据 title/department/job_title 推断角色（**多值**：一词可映射多域，如总经理→budget+approve）
// 无匹配 → 空数组
export function inferRoles(contact, roleMap = DEFAULT_ROLE_MAP) {
  const hay = `${contact?.title || ''} ${contact?.department || ''} ${contact?.job_title || ''}`.toLowerCase();
  const roles = [];
  for (const m of roleMap) {
    if (m.role && m.keywords.some((k) => hay.includes(k.toLowerCase()))) roles.push(m.role);
  }
  return roles;
}

// 单值便捷（调用方需要首角色时用；默认返回第一个，无匹配 null）
export function inferRole(contact, roleMap = DEFAULT_ROLE_MAP) {
  return inferRoles(contact, roleMap)[0] ?? null;
}

// 纯函数：决策链完整性与漂移判定
//   contacts: [{title, department, job_title, decision_power}]
//   opts.template / opts.roleMap 可配置（缺省 DEFAULT_*）
// 返回 { completeness, missingRoles, driftContacts, assigned }
export function validateDecisionChain(contacts = [], _ctx = {}, opts = {}) {
  const template = opts.template || DEFAULT_ROLE_TEMPLATE;
  const roleMap = opts.roleMap || DEFAULT_ROLE_MAP;
  const required = Array.isArray(template.required) ? template.required : [];
  const list = Array.isArray(contacts) ? contacts : [];

  const assigned = list.map((c) => ({
    contact: c,
    role: c.decision_power || inferRole(c, roleMap),
  }));
  // 只统计「模板 required 中被覆盖」的角色（Set.size 会误算非必需角色 → 虚高）
  const coveredRequired = new Set(
    assigned.map((a) => a.role).filter((r) => r && required.includes(r))
  );
  const missingRoles = required.filter((r) => !coveredRequired.has(r));

  // 漂移：声明了 decision_power，但 title/department 推断「多值角色」不覆盖该声明。
  // 用 inferRoles 多值（总经理→[budget,approve]），声明为其中任一 → 不算漂移；
  // 推断为空（title 无可映射关键词）→ 无法佐证，判漂移。
  const driftContacts = assigned
    .filter((a) => {
      if (!a.contact.decision_power) return false;
      const inferred = inferRoles(a.contact, roleMap);
      return inferred.length === 0 || !inferred.includes(a.contact.decision_power);
    })
    .map((a) => ({
      title: a.contact.title,
      department: a.contact.department,
      declared: a.contact.decision_power,
      inferred: inferRoles(a.contact, roleMap)[0] ?? null,
    }));

  const completeness = required.length ? coveredRequired.size / required.length : 1.0;
  return { completeness, missingRoles, driftContacts, assigned };
}
