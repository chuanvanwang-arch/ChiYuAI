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
