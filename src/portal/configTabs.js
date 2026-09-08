// src/portal/configTabs.js — 配置中心一级分组 TAB 可见性（§15 权限重分组 + T5 占位）
// 纯函数，便于单测；config.html 通过 /portal/configTabs.js 引入。
export function buildLevelTabs(me = {}) {
  const level = me.level || null;
  const isAdmin = level === 'ADMIN';
  return [
    // 系统级：仅 ADMIN 可点；非 ADMIN 显示不可点占位（暴露分组名，不泄露条目明细）
    { level: 'system', name: '系统级', visible: true, placeholder: !isAdmin },
    { level: 'tenant', name: '租户级', visible: true, placeholder: false },
    // 传播中枢（上下贯通 §15.5）：权限等同系统级，仅 ADMIN 可点
    { level: 'propagation', name: '全局复用与经验蔓延', visible: true, placeholder: !isAdmin },
  ];
}
