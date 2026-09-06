// G1+G2 主题 token 化：将各页内嵌 <style> 的硬编码色改为 var(--*) 设计 Token。
// 仅改 <style> 内颜色值，保留布局；body 背景归一到 --bg；白字恢复；修正 /web/ 误链。
import fs from 'node:fs';
import path from 'node:path';

const dir = 'src/web';
const skip = new Set(['home.html', 'portal-stage3-mockup.html']);

// 硬编码色 -> Token 映射（小写键）
const map = {
  // 中性浅色表面 -> 面板/背景
  '#fafafa': 'var(--panel)', '#f7f8fb': 'var(--panel)', '#f5f7fa': 'var(--panel)',
  '#f8fafc': 'var(--panel)', '#f4f6f8': 'var(--panel)', '#f5f6f8': 'var(--panel)',
  '#f1f5f9': 'var(--panel)', '#fafbfc': 'var(--panel)', '#f5f5f5': 'var(--panel)',
  '#f0f0f0': 'var(--panel)', '#f2f3f5': 'var(--panel)', '#f2f2f2': 'var(--panel)',
  '#f7f7f5': 'var(--panel)', '#f3f4f6': 'var(--panel)', '#f9fafb': 'var(--panel)',
  '#eef': 'var(--panel)', '#eee': 'var(--panel)', '#fefefe': 'var(--panel)',
  '#eff6ff': 'var(--as)', '#eef2ff': 'var(--as)', '#e0e7ff': 'var(--as)',
  '#c7d2fe': 'var(--ac-hover)', '#dbeafe': 'var(--as)', '#e8f3ff': 'var(--as)',
  '#bfdbfe': 'var(--as)', '#cfe': 'var(--as)',
  // 边框/分隔线 -> 线
  '#e5e7eb': 'var(--line)', '#e5e6eb': 'var(--line)', '#d6dce4': 'var(--line)',
  '#d7dce4': 'var(--line)', '#e8eef7': 'var(--line)', '#eef2f7': 'var(--line)',
  '#eef1f5': 'var(--line)', '#e9edf1': 'var(--line)', '#e7eef6': 'var(--line)',
  '#e7f7ec': 'var(--line)', '#f1f3f5': 'var(--line)', '#f2f3f5': 'var(--line)',
  '#ddd': 'var(--line)', '#ccc': 'var(--line)', '#cbd5e1': 'var(--line)',
  '#cbd5e0': 'var(--line)', '#e5e5e0': 'var(--line)', '#d6f5dd': 'var(--line)',
  // 深色文本 -> 墨色
  '#222': 'var(--ink)', '#333': 'var(--ink)', '#1f2329': 'var(--ink)',
  '#1f2937': 'var(--ink)', '#1f2933': 'var(--ink)', '#1c2330': 'var(--ink)',
  '#1e2a38': 'var(--ink)', '#1f2328': 'var(--ink)', '#1e1e1e': 'var(--ink)',
  '#0a0a0a': 'var(--ink)', '#000': 'var(--ink)', '#000000': 'var(--ink)',
  // 次级文本 -> 弱化
  '#666': 'var(--mut)', '#6b7280': 'var(--mut)', '#64748b': 'var(--mut)',
  '#86909c': 'var(--mut)', '#8a93a2': 'var(--mut)', '#8a94a6': 'var(--mut)',
  '#9ca3af': 'var(--mut)', '#94a3b8': 'var(--mut)', '#9aa0a6': 'var(--mut)',
  '#888': 'var(--mut)', '#999': 'var(--mut)', '#aaa': 'var(--mut)',
  '#555': 'var(--mut)', '#444': 'var(--mut)', '#99a': 'var(--mut)',
  '#4e5969': 'var(--mut)', '#647489': 'var(--mut)', '#6b7480': 'var(--mut)',
  '#475569': 'var(--mut)', '#fde2e2': 'var(--err)', '#166534': '#fff',
  '#4a6785': 'var(--mut)', '#e6e6e6': 'var(--mut)',
  // 主色蓝 -> 强调
  '#0a66c2': 'var(--ac)', '#2563eb': 'var(--ac)', '#1f4e8c': 'var(--ac)',
  '#165dff': 'var(--ac)', '#1d4ed8': 'var(--ac)', '#1a4fb8': 'var(--ac)',
  '#1f6feb': 'var(--ac)', '#3730a3': 'var(--ac)', '#1e3a8a': 'var(--ac)',
  '#3b82f6': 'var(--ac)', '#4f46e5': 'var(--ac)', '#7a3bb6': 'var(--ac)',
  '#8b5cf6': 'var(--ac)', '#084c8c': 'var(--ac)', '#1e40af': 'var(--ac)',
  // 成功绿 -> ok
  '#16a34a': 'var(--ok)', '#137333': 'var(--ok)', '#0a8a3f': 'var(--ok)',
  '#16794e': 'var(--ok)', '#3b6d11': 'var(--ok)', '#dcfce7': 'var(--ok)',
  '#86efac': 'var(--ok)', '#08979c': 'var(--ok)', '#e6fffb': 'var(--ok)',
  '#5fd38a': 'var(--ok)', '#0f7b63': 'var(--ok)', '#0a0': 'var(--ok)',
  '#e6f7e6': 'var(--ok)', '#e7f7ec': 'var(--ok)', '#6b7480': 'var(--mut)',
  // 错误红 -> err（浅红底也归 err 语义）
  '#b91c1c': 'var(--err)', '#991b1b': 'var(--err)', '#a3321f': 'var(--err)',
  '#cf1322': 'var(--err)', '#ef4444': 'var(--err)', '#fca5a5': 'var(--err)',
  '#f08a8a': 'var(--err)', '#fee2e2': 'var(--err)', '#c0392b': 'var(--err)',
  '#a32d2d': 'var(--err)', '#dc2626': 'var(--err)', '#fde8e8': 'var(--err)',
  '#fff1f0': 'var(--err)',
  // 警告琥珀 -> warn（深琥珀字归白）
  '#fef3c7': 'var(--warn)', '#fde68a': 'var(--warn)', '#ffd591': 'var(--warn)',
  '#fff7e6': 'var(--warn)', '#ffe0a3': 'var(--warn)', '#b8860b': '#fff',
  '#f59e0b': 'var(--warn)', '#fef9c3': 'var(--warn)', '#854d0e': '#fff',
  '#ffedd5': 'var(--warn)', '#9a3412': '#fff', '#e0b45a': 'var(--warn)',
  '#fef6e0': 'var(--warn)', '#ea580c': 'var(--warn)', '#ff8c00': 'var(--warn)',
  '#8a5a00': '#fff', '#92400e': '#fff', '#b08a1a': 'var(--warn)',
  // 深色块面（配置页分区底）-> 面板
  '#1e3a5f': 'var(--panel)', '#16304f': 'var(--panel)', '#14361f': 'var(--panel)',
  '#3a1414': 'var(--panel)', '#3a2e14': 'var(--panel)', '#1a1d23': 'var(--panel)',
  '#2a2d34': 'var(--panel)', '#7a2e2e': 'var(--panel)', '#0f1115': 'var(--bg)',
  // 代码块（config.html 深底浅字）
  '#0b1020': 'var(--bg)', '#d6e2ff': 'var(--ac-hover)',
  // 白（背景场景）-> 面板
  '#fff': 'var(--panel)', '#ffffff': 'var(--panel)',
};

const entries = Object.entries(map);

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.html')) continue;
  if (skip.has(f)) continue;
  const p = path.join(dir, f);
  let s = fs.readFileSync(p, 'utf8');
  const before = s;

  // 修正 /web/ 误链 -> /portal/
  s = s.replace(/href="\/web\/tokens\.css"/g, 'href="/portal/tokens.css"');
  s = s.replace(/href="\/web\/common\.css"/g, 'href="/portal/common.css"');

  // 仅转换 <style> 内颜色
  s = s.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, inner, close) => {
    let body = inner;
    for (const [k, v] of entries) {
      body = body.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), v);
    }
    return open + body + close;
  });

  // body 背景归一到 --bg（与 common.css 一致）
  s = s.replace(/body\s*\{\s*background:\s*var\(--panel\)/g, 'body{background:var(--bg)');
  s = s.replace(/body\s*\{\s*background:\s*var\(--as\)/g, 'body{background:var(--bg)');
  // 白字恢复（按钮/徽标上的白字，被上面的 #fff->panel 误伤）
  s = s.replace(/color:\s*var\(--panel\)/g, 'color:#fff');
  s = s.replace(/color:\s*var\(--as\)/g, 'color:#fff');

  if (s !== before) fs.writeFileSync(p, s);
}

console.log('G1/G2 transform done.');
