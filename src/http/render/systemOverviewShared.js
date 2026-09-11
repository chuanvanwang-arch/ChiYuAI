// 三系统概览页共享：趋势 polyline 生成 + 采样读取（零新增对外 API）
import { query as defaultQuery } from '../../db.js';

// 纯函数：values → "x,y x,y ..."，viewBox 200x40，y 区间 [5,35]，x 区间 [0,200]
export function buildTrendPolyline(values, { w = 200, h = 40, padY = 5 } = {}) {
  const n = values.length;
  if (n === 0) return '';
  if (n === 1) return `0.0,${(h / 2).toFixed(1)}`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const innerH = h - 2 * padY;
  if (span === 0) {
    // 恒定序列：居中水平线，避免贴底
    return values.map((_, i) => `${(i / (n - 1) * w).toFixed(1)},${(h / 2).toFixed(1)}`).join(' ');
  }
  return values.map((v, i) => {
    const x = (i / (n - 1)) * w;
    const y = (h - padY) - ((v - min) / span) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

// 读近 days 日采样；支持注入 query（测试用）；异常安全降级为空数组
export async function getTrendSamples(metric, { tenantId = 'system', days = 30, deps = {} } = {}) {
  const q = deps.query || defaultQuery;
  try {
    const r = await q(
      `SELECT value FROM crm.system_overview_sample
       WHERE metric = $1 AND tenant_id = $2
         AND sample_date >= CURRENT_DATE - ($3 || ' days')::interval
       ORDER BY sample_date ASC`,
      [metric, tenantId, String(days)]
    );
    return (r.rows || []).map((row) => Number(row.value));
  } catch {
    return [];
  }
}

const escA = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 纯函数：values → 趋势渲染零件（mode / polyline / 数据点 / 末值）
// mode：'empty'（无采样）| 'accumulating'（仅 1 个采样日：画可见圆点 + 末值提示）| 'line'（≥2 点成线）
// 为什么需要 accumulating：采样表刚上线时只有 1 天数据，单点 polyline 画不出任何东西 → 趋势区"看着空白像坏了"。
export function buildTrendParts(values, { w = 200, h = 40, padY = 5 } = {}) {
  const arr = Array.isArray(values) ? values.map(Number).filter((v) => Number.isFinite(v)) : [];
  const n = arr.length;
  if (n === 0) return { mode: 'empty', polyline: '', dots: [], last: null, n: 0 };
  if (n === 1) {
    // 单点贴右端（代表"最新一个采样日"），并回显末值，让真实数据可见
    return { mode: 'accumulating', polyline: '', dots: [{ x: w - 6, y: h / 2 }], last: arr[0], n: 1 };
  }
  const polyline = buildTrendPolyline(arr, { w, h, padY });
  const dots = polyline.split(' ').filter(Boolean).map((pt) => {
    const [x, y] = pt.split(',').map(Number);
    return { x, y };
  });
  return { mode: 'line', polyline, dots, last: arr[n - 1], n };
}

// 统一趋势图 SVG（K/M/D 三页复用）。取色/字号**内联**：这些 class 在样式表里并无定义，
// 仅靠 class 会回落黑色文本填充，在深色主题下等于不可见（历史"趋势空白"的成因之一）。
export function renderTrendChart(values, { label = '近 30 日趋势', trendId = 'trend', stroke = 'var(--ac)', w = 200, h = 40 } = {}) {
  const p = buildTrendParts(values, { w, h });
  const open = `<svg data-trend="${escA(trendId)}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="${escA(label)}">`;
  if (p.mode === 'empty') {
    return `${open}<text x="4" y="24" class="so-trend-empty" fill="var(--mut,#8b93a7)" font-size="11">暂无采样数据</text></svg>`;
  }
  if (p.mode === 'accumulating') {
    const d = p.dots[0];
    return `${open}<circle cx="${d.x}" cy="${d.y}" r="3" fill="${stroke}"></circle>`
      + `<text x="4" y="24" class="so-trend-empty" fill="var(--mut,#8b93a7)" font-size="11">今日 ${escA(p.last)} · 采样积累中</text></svg>`;
  }
  const dots = p.dots.map((d) => `<circle cx="${d.x}" cy="${d.y}" r="2.2" fill="${stroke}"></circle>`).join('');
  return `${open}<polyline points="${p.polyline}" fill="none" stroke="${stroke}" stroke-width="1.5"></polyline>${dots}</svg>`;
}
