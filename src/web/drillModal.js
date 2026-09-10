// src/web/drillModal.js — 通用下钻模态框（监控概览页复用）
//
// 契约：在 root 容器内，可下钻行带 data-dk="<key>"；对应隐藏详情块：
//   <div class="so-detail-hidden" data-dk="<key>">...富 HTML...</div>
// 点击行 → 取其 data-dk，在 DOM 内查找同 key 隐藏块，注入模态框并打开。
// 零新增 API：所有详情内容由服务端渲染器预先产出（隐藏于 DOM，按需显隐）。
const MODAL_ID = 'so-drill-modal';
let styleInjected = false;

function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
.so-drill-modal{position:fixed;inset:0;z-index:1000;display:none;}
.so-drill-modal.so-drill-open{display:block;}
.so-drill-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.45);}
.so-drill-card{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  max-width:680px;width:92%;max-height:82vh;overflow:auto;background:var(--bg,#fff);
  border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);}
.so-drill-head{display:flex;justify-content:space-between;align-items:center;
  padding:14px 18px;border-bottom:1px solid var(--line,#eee);}
.so-drill-title{font-weight:600;font-size:15px;}
.so-drill-x{border:none;background:none;font-size:22px;cursor:pointer;line-height:1;color:var(--mut,#888);}
.so-drill-body{padding:16px 18px;}
.so-detail-hidden{display:none;}
.pg-table tbody tr[data-dk]{cursor:pointer;}
.pg-table tbody tr[data-dk]:hover{background:var(--hover,#f5f7fa);}
.so-dl{display:grid;grid-template-columns:150px 1fr;gap:7px 12px;margin:0;}
.so-dl dt{color:var(--mut,#666);font-size:13px;}
.so-dl dd{margin:0;font-size:13px;word-break:break-word;}
.so-d-sub{margin:14px 0 6px;font-size:13px;color:var(--mut,#666);}
.so-ref-list{margin:0;padding-left:18px;font-size:13px;}
.so-ref-list li{margin:3px 0;}
.so-l3-list{display:flex;flex-direction:column;gap:6px;margin-top:8px;}
.so-l3-item{border:1px solid var(--line,#eee);border-radius:8px;padding:8px 10px;cursor:pointer;
  display:flex;flex-direction:column;gap:2px;}
.so-l3-item:hover{background:var(--hover,#f5f7fa);}
.so-l3-id{font-family:monospace;font-size:12px;}
.so-l3-meta{font-size:12px;color:var(--mut,#888);}
`;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);
}

function ensureModal() {
  let m = document.getElementById(MODAL_ID);
  if (m) return m;
  injectStyle();
  m = document.createElement('div');
  m.id = MODAL_ID;
  m.className = 'so-drill-modal';
  m.innerHTML = `
    <div class="so-drill-backdrop" data-close="1"></div>
    <div class="so-drill-card" role="dialog" aria-modal="true">
      <div class="so-drill-head">
        <span class="so-drill-title" id="${MODAL_ID}-title"></span>
        <button class="so-drill-x" type="button" aria-label="关闭" data-close="1">&times;</button>
      </div>
      <div class="so-drill-body" id="${MODAL_ID}-body"></div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('click', (e) => { if (e.target.dataset.close) closeDrill(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrill(); });
  return m;
}

export function closeDrill() {
  const m = document.getElementById(MODAL_ID);
  if (m) m.classList.remove('so-drill-open');
}

export function openDrill({ title, key, root }) {
  ensureModal();
  const m = document.getElementById(MODAL_ID);
  const body = document.getElementById(MODAL_ID + '-body');
  const t = document.getElementById(MODAL_ID + '-title');
  // 精确命中隐藏详情块（同一 data-dk 在表格行与隐藏块各出现一次，须排除行）
  const block = root.querySelector('.so-detail-hidden[data-dk="' + (window.CSS ? CSS.escape(key) : key) + '"]');
  body.innerHTML = block ? block.innerHTML : '<div class="dn-empty">无详情数据</div>';
  t.textContent = title || '详情';
  m.classList.add('so-drill-open');
}

// 在 root 上挂委托监听（root 元素本身不被 innerHTML 替换，故只需绑定一次）
export function bindDrill(rootSelector) {
  const root = document.querySelector(rootSelector);
  if (!root) return;
  root.addEventListener('click', (e) => {
    const row = e.target.closest('[data-dk]');
    if (!row) return;
    const key = row.getAttribute('data-dk');
    const title = row.getAttribute('data-drill-title') || (row.textContent || '').trim().slice(0, 48);
    openDrill({ title, key, root });
  });
}
