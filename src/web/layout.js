// src/web/layout.js — 统一布局注入：顶栏(⌘K命令面板+头像用户菜单) + 左侧导航(RBAC) + 页面壳
// 用法：<script type="module">import { injectLayout } from '/portal/layout.js'; injectLayout();</script>
import { registerComponents } from './components.js';
registerComponents();
import { menuFor } from '../portal/layoutMenu.js';
import { get } from './api.js';

// 纯函数：左侧导航 HTML（group→items，当前路径高亮）
// badges（2026-08-31 客户跟踪告警角标）：形如 { [href]: number }，值 > 0 时在该导航项右侧渲染红色角标。
//   向后兼容铁律：不传 / 值为 0、负数、非数字时，输出与改造前逐字节一致（既有页面与单测不受影响）。
//   安全：值经 Number() 归一后仅渲染整数语义，传入 HTML 片段会得到 NaN → 不渲染（防 XSS 注入）。
export function navHtml(role, badges = {}, entitlements = null) {
  const groups = {};
  for (const m of menuFor(role, entitlements)) (groups[m.group] ||= []).push(m);
  const active = (typeof location !== 'undefined') ? location.pathname : '';
  return Object.entries(groups)
    .map(([g, items]) =>
      `<div class="nav-group"><div class="nav-group-title">${g}</div>` +
      items.map((i) => {
        const isActive = active === i.href || (i.href !== '/' && active.startsWith(i.href.split('?')[0]));
        const n = Number(badges?.[i.href] || 0);
        const badgeHtml = n > 0 ? `<span class="nav-badge">${Math.floor(n)}</span>` : '';
        // 标签包一层 <span>：把裸文本节点（display:flex 下会被包成 anonymous flex item，
        // 在部分浏览器/字体/缩放下首字符会被 flex 容器左边裁掉）换成真实元素，
        // 统一 .nav-item 文本渲染的 box 模型。视觉无变化（gap:8px 在单子元素下为 0）。
        return `<a class="nav-item${isActive ? ' active' : ''}" href="${i.href}"><span class="nav-label">${i.label}</span>${badgeHtml}</a>`;
      }).join('') + `</div>`)
    .join('');
}

// 纯函数：头像用户小菜单 HTML（我的审批/我的任务/工作台/我的API Key；系统仅 admin；退出）
export function userMenuHtml(role) {
  const sys = role === 'admin' || role === 'sysadmin'
    ? `<div class="user-menu-sep"></div>` +
      `<a class="user-menu-item" href="/config">⚙ 配置中心</a>` +
      `<a class="user-menu-item" href="/agent-workbench.html">🤖 智能体中心</a>`
    : '';
  return `<div class="user-menu">
    <a class="user-menu-item" href="/workbench.html">✅ 我的审批</a>
    <a class="user-menu-item" href="/named-accounts.html">📋 我的任务</a>
    <a class="user-menu-item" href="/">🏠 工作台</a>
    <a class="user-menu-item" href="/my-api-keys.html">🔑 我的 API Key</a>
    ${sys}
    <div class="user-menu-sep"></div>
    <a class="user-menu-item danger" id="logout3" href="#">🚪 退出登录</a>
  </div>`;
}

// 纯函数：全站页脚版权（2026-09-06）—— 每页底部统一展示公司版权与生产域名，单一事实源
export function footerHtml() {
  return '<span>北京青羽智行科技有限公司 © 2023-2026 版权所有</span>' +
         '<span class="f-sep">｜</span>' +
         '<span>chiyuai.com</span>' +
         '<span class="f-sep">·</span>' +
         '<span>本平台相关内容同步更新</span>';
}

// 浏览器注入：顶栏 + 侧栏 + 页面壳（页面调用）
export function injectLayout() {
  const token = localStorage.getItem('crm_token');
  const role = localStorage.getItem('crm_role') || '';
  const name = localStorage.getItem('crm_name') || '客';
  const shell = document.createElement('div');
  shell.id = 'appShell';
  shell.className = 'app-shell';
  shell.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/">⚡ 企业AI销售决策平台·ChiYu青羽</a>
      <div class="cmdbar"><span class="kbd">⌘K</span><input id="cmdInput" placeholder="输入指令，如：给 30 天未跟进的商机生成唤醒邮件"></div>
      <div class="topbar-right">
        <div class="avatar" id="avatar" tabindex="0">
          <span class="avatar-char">${(name || '客')[0]}</span>
          <span class="avatar-role ${role}">${role || '未登录'}</span>
        </div>
        <div class="user-menu-wrap" id="userMenuWrap" hidden>${userMenuHtml(role)}</div>
      </div>
    </header>
    <aside class="sidebar">${navHtml(role)}</aside>
    <main class="content"><div id="pageHost"></div></main>
    <footer class="app-footer">${footerHtml()}</footer>`;
  // 迁移原页面 body 子节点到 pageHost
  while (document.body.firstChild) shell.querySelector('#pageHost').appendChild(document.body.firstChild);
  document.body.appendChild(shell);

  // ── 侧栏角标（2026-08-31）：客户跟踪 + 我的待办，启动拉一次 + 每 60s 轮询 ──
  // 容错：未登录/端点异常时静默，角标保持上次成功值，绝不阻断页面渲染
  const FOLLOW_HREF = '/named-accounts.html';
  const TODO_HREF = '/my-todo.html';
  const POLL_MS = 60000;
  const sidebarEl = shell.querySelector('.sidebar');
  let navBadges = {};
  // 套餐权益集（2026-09-06 菜单门禁）：null = 未加载/加载失败 → 不过滤（容错，绝不因门禁端点异常清空导航）
  let navEnts = null;
  const renderNav = () => { if (sidebarEl) sidebarEl.innerHTML = navHtml(role, navBadges, navEnts); };

  // 按当前租户订阅档位过滤菜单（单一事实源 = config_store['billing-plans'] → resolveEntitlements）
  const loadEntitlements = async () => {
    try {
      const j = await get('/api/billing/entitlements');
      if (Array.isArray(j?.entitlements)) { navEnts = new Set(j.entitlements); renderNav(); }
    } catch { /* 静默：保持不过滤 */ }
  };
  loadEntitlements();

  // 客户跟踪角标：应访未访(红) ∪ 长期失联
  const pollFollowBadge = async () => {
    try {
      const j = await get('/api/board/named-account-manage');
      const n = Number(j?.followReminders || 0);
      if ((navBadges[FOLLOW_HREF] || 0) !== n) {
        if (n > 0) navBadges[FOLLOW_HREF] = n; else delete navBadges[FOLLOW_HREF];
        renderNav();
      }
    } catch { /* 静默 */ }
  };

  // 我的待办角标：待我审批数（approval 视角 TODO 任务匹配当前人/角色）
  const pollTodoBadge = async () => {
    try {
      const j = await get('/api/my-todo/badge');
      const n = Number(j?.approval || 0);
      if ((navBadges[TODO_HREF] || 0) !== n) {
        if (n > 0) navBadges[TODO_HREF] = n; else delete navBadges[TODO_HREF];
        renderNav();
      }
    } catch { /* 静默 */ }
  };

  const pollAllBadges = () => Promise.all([pollFollowBadge(), pollTodoBadge()]);
  pollAllBadges();
  setInterval(pollAllBadges, POLL_MS);

  // 头像菜单开关（点击外部关闭）
  const avatar = document.getElementById('avatar');
  const wrap = document.getElementById('userMenuWrap');
  avatar.addEventListener('click', (e) => { e.stopPropagation(); wrap.hidden = !wrap.hidden; });
  document.addEventListener('click', () => { if (!wrap.hidden) wrap.hidden = true; });

  // 退出登录
  document.getElementById('logout3')?.addEventListener('click', () => { localStorage.clear(); location.href = '/home.html'; });

  // ── ⌘K 命令面板（导航第二入口；RBAC 过滤系统组；输入过滤） ──
  const cmdInput = document.getElementById('cmdInput');
  let panelEl = null, sel = 0, list = [];
  const DETAIL_PAGES = [
    { href: '/deal-detail.html', label: '商机详情' },
    { href: '/quotation-detail.html', label: '报价详情' },
    { href: '/contract-detail.html', label: '合同详情' },
    { href: '/order-detail.html', label: '订单详情' },
    { href: '/payment-detail.html', label: '回款详情' },
    { href: '/invoice-detail.html', label: '发票详情' },
  ];
  const entries = () => [
    ...menuFor(role, navEnts).map((m) => ({ ...m, grp: m.group })),
    ...DETAIL_PAGES.map((d) => ({ ...d, grp: '业务' })),
    { href: '/', label: '工作台', grp: '首页' },
  ];
  function openPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.className = 'cmd-overlay';
    panelEl.innerHTML = `
      <div class="cmd-panel">
        <div class="cmd-input-box"><span class="kbd">⌘K</span>
          <input id="cmdSearch" placeholder="搜索页面…（回车跳转）/ 或输入业务指令直达?" /></div>
        <div class="cmd-list" id="cmdList"></div>
      </div>`;
    document.body.appendChild(panelEl);
    const box = panelEl.querySelector('#cmdSearch');
    const listEl = panelEl.querySelector('#cmdList');
    const render = (q) => {
      const ql = (q || '').trim().toLowerCase();
      let pool = entries();
      if (ql) pool = pool.filter((i) => (i.label + ' ' + i.grp).toLowerCase().includes(ql));
      list = pool;
      sel = 0;
      listEl.innerHTML = pool.length
        ? pool.map((i, idx) =>
            `<div class="cmd-item${idx === 0 ? ' on' : ''}" data-i="${idx}"><span class="grp">${i.grp}</span>${i.label}<span class="k">↵</span></div>`).join('')
        : `<div class="cmd-empty">无匹配页面 — 回车将作为业务指令发送</div>`;
    };
    const go = (i) => {
      const item = list[i];
      if (item) location.href = item.href;
      else { const q = box.value.trim(); if (q) location.href = '/?nl=' + encodeURIComponent(q); }
    };
    box.addEventListener('input', () => render(box.value));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.length) { sel = (sel + 1) % list.length; listEl.children[sel]?.classList.add('on'); listEl.children[(sel + list.length - 1) % list.length]?.classList.remove('on'); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (list.length) { sel = (sel - 1 + list.length) % list.length; listEl.children[sel]?.classList.add('on'); listEl.children[(sel + 1) % list.length]?.classList.remove('on'); } }
      else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
      else if (e.key === 'Escape') closePanel();
    });
    listEl.addEventListener('click', (e) => {
      const it = e.target.closest('.cmd-item');
      if (it) go(Number(it.dataset.i));
    });
    panelEl.addEventListener('click', (e) => { if (e.target === panelEl) closePanel(); });
    render('');
    box.focus();
  }
  function closePanel() { panelEl?.remove(); panelEl = null; }

  // ⌘K 快捷键打开；命令栏输入聚焦（保留 copilot 直达语义）
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openPanel(); }
  });
  cmdInput?.addEventListener('focus', () => openPanel());
  cmdInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) location.href = '/?nl=' + encodeURIComponent(e.target.value.trim());
  });

  // 角色自适应（有 token 才试，失败静默）
  if (token) {
    get('/api/auth/me')
      .then((j) => { if (j.role && j.role !== role && j.display_name) { localStorage.setItem('crm_role', j.role); localStorage.setItem('crm_name', j.display_name); location.reload(); } })
      .catch(() => {});
  }
}