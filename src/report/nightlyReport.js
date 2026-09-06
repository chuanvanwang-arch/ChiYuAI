// src/report/nightlyReport.js — 夜批三段全量日报：收集 → 纯模板渲染 → 落盘 + upsert
// 铁律：renderNightlyMarkdown 零额外 LLM 调用（仅聚合三段既有结果；复盘段①自身仍由 LLM 产出归因，属既有行为）
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';

const REPORT_DIR = new URL('../../reports/nightly/', import.meta.url);

export async function ensureNightlyReportTable() {
  await query(`CREATE TABLE IF NOT EXISTS crm.nightly_report (
    report_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_date        DATE NOT NULL UNIQUE,
    title           TEXT,
    file_path       TEXT,
    seg_retro_json  JSONB,
    seg_routing_json JSONB,
    seg_param_json  JSONB,
    total_tasks     INT,
    healthy         INT,
    drift           INT,
    patches_count   INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`).catch((e) => { throw e; });
}

// 归一化三段返回（容错：任一段为 null 时给空结构，避免渲染崩）
export function collectSegments({ retro, routing, param } = {}) {
  return {
    retro: retro || {},
    routing: routing || { closed: 0, patches: [], nextArms: [], insufficient: [], errors: [] },
    param: {
      inspected: param?.inspected ?? 0,
      healthy: param?.healthy ?? 0,
      drift: param?.drift ?? 0,
      unknown: param?.unknown ?? 0,
      patches: Array.isArray(param?.patches) ? param.patches : [],
      // 贯穿 param.items（含九尺子明细）；此前被丢弃，导致九尺子调整在夜报不可见
      items: Array.isArray(param?.items) ? param.items : [],
    },
  };
}

// 表单化处方文案（决策复盘 / 路由 / 参数 通用）
function fmtPatch(p) {
  if (!p) return '方案草稿';
  const target = p.target ?? p.scenario_id ?? '实验';
  if (p.from_value !== undefined && p.to_value !== undefined) {
    return `${target}：${JSON.stringify(p.from_value)} → ${JSON.stringify(p.to_value)}`;
  }
  return `${target} → ${p.label || p.knob || '方案草稿'}`;
}

// 从 retro 段提取统一指标（兼容两种形态，避免落库后回读时计数恒 0）：
//   实时形态：{ decisions_scanned, clusters:[{degraded?,llm_used,confidence,root_cause_explanation,draft_patches}], draft_patches, llm_enabled, llm_effective, summary }
//   持久化形态（落库后回读 seg_retro_json）：{ run_at, summary:{ clusters, llm_effective, drafts, llm_enabled, by_root_cause }, clusters:[{llm_used,confidence,root_cause_explanation,draft_patches}] }
//   约定：以 summary.* 为权威聚合；clusters 数组为明细（失败原因 / 处方）。任一缺失即回退到顶层字段。
export function extractRetroMetrics(retro = {}) {
  const sum = retro.summary || {};
  const clustersArr = Array.isArray(retro.clusters) ? retro.clusters : [];
  // 运行总数统一取「分析簇数」（summary.clusters，两种形态均存在）；decisions_scanned 仅作附加上下文子行
  const total = sum.clusters ?? clustersArr.length ?? 0;
  const llmEff = sum.llm_effective ?? clustersArr.filter((c) => c.llm_used === true).length ?? 0;
  const ok = llmEff;
  const drift = Math.max(0, total - ok);
  const draftCount =
    sum.drafts ??
    (Array.isArray(retro.draft_patches) ? retro.draft_patches.length : 0) +
      clustersArr.reduce((n, c) => n + (Array.isArray(c.draft_patches) ? c.draft_patches.length : 0), 0);
  const llmEnabled = !!(sum.llm_enabled ?? retro.llm_enabled);
  const failReasons = clustersArr
    .filter((c) => c.llm_used === false || (typeof c.confidence === 'number' && c.confidence < 0.7))
    .map((c) => c.root_cause_explanation || (c.scenario_id ? `场景 ${c.scenario_id} 未充分分析` : 'LLM 降级'))
    .filter(Boolean);
  const byRootCause = sum.by_root_cause && typeof sum.by_root_cause === 'object' ? sum.by_root_cause : {};
  const scanned = typeof retro.decisions_scanned === 'number' ? retro.decisions_scanned : null;
  return { total, ok, drift, draftCount, llmEnabled, llmEff, failReasons, byRootCause, scanned };
}

// 纯模板渲染（无 LLM）：三段结构 + 运行总数/成功/失败/失败原因/建议调整措施
export function renderNightlyMarkdown({ date, retro = {}, routing = {}, param = {} } = {}) {
  const lines = [];
  lines.push(`# 夜批运行报告 ${date}`);
  lines.push('');
  lines.push(`> 自动生成于夜批（02:00）。复盘段由 LLM 产出归因；本报告仅汇总三段既有结果，不二次调用模型。`);
  lines.push('');

  // ① 决策复盘
  lines.push(`## ① 决策复盘`);
  const R = extractRetroMetrics(retro);
  lines.push(`- 运行总数（分析簇）：${R.total}`);
  if (R.scanned != null) lines.push(`- 扫描决策总数：${R.scanned}`);
  lines.push(`- 成功（LLM 生效簇）：${R.ok}（llm_enabled=${R.llmEnabled}, llm_effective=${R.llmEff}）`);
  lines.push(`- 失败（未获 LLM / 降级簇）：${R.drift}`);
  const rootCauseStr = Object.entries(R.byRootCause).map(([k, v]) => `${k} ${v}`).join('、');
  if (rootCauseStr) lines.push(`- 根因分布：${rootCauseStr}`);
  lines.push(`- 失败原因：${R.failReasons.join('；') || '无'}`);
  // 建议调整措施：聚合各簇 draft_patches（含实时形态顶层 draft_patches）
  const retroDrafts = [];
  const clustersArr = Array.isArray(retro.clusters) ? retro.clusters : [];
  for (const c of clustersArr) if (Array.isArray(c.draft_patches)) for (const p of c.draft_patches) retroDrafts.push(p);
  if (Array.isArray(retro.draft_patches)) for (const p of retro.draft_patches) retroDrafts.push(p);
  lines.push(`- 建议调整措施：${retroDrafts.map((p) => fmtPatch(p)).join('；') || '无'}`);
  lines.push('');

  // ② 路由收口
  lines.push(`## ② 路由收口`);
  const rTotal = (routing.closed || 0) + (routing.insufficient || []).length + (routing.errors || []).length;
  lines.push(`- 运行总数：${rTotal}`);
  lines.push(`- 成功（收口结论）：${routing.closed || 0}`);
  lines.push(`- 失败（错误/样本不足）：${(routing.errors || []).length + (routing.insufficient || []).length}`);
  lines.push(`- 失败原因：${(routing.errors || []).concat((routing.insufficient || []).map((e) => '样本不足:' + (e.experiment_id || e))).join('；') || '无'}`);
  lines.push(`- 建议调整措施：${(routing.patches || []).map((p) => `${p.target || '实验'} → 收口处方`).join('；') || '无'}`);
  lines.push('');

  // ③ 参数体检（含九尺子扩展）
  lines.push(`## ③ 参数体检`);
  lines.push(`- 运行总数：${param.inspected ?? 0}`);
  lines.push(`- 成功（healthy）：${param.healthy ?? 0}`);
  lines.push(`- 失败（drift）：${param.drift ?? 0}`);
  lines.push(`- 失败原因与建议调整措施：`);
  const patches = param.patches || [];
  if (patches.length === 0) {
    // 修复口径不一致：drift>0 但无自动建议值时，不再误显示「全部健康」
    if ((param.drift ?? 0) > 0) {
      lines.push(`  - 已漂移 ${param.drift} 项但暂无自动建议值（需人工研判；见下方九尺子参数快照）`);
    } else {
      lines.push('  - 无（全部健康）');
    }
  } else {
    for (const p of patches) {
      lines.push(`  - ${p.target}：当前值 ${JSON.stringify(p.from_value)} → 建议 ${JSON.stringify(p.to_value)}（风险 ${p.risk || 'LOW'}）`);
    }
  }
  // 九尺子参数快照（全量可见：全局 rubric-* 阈值/权重/LLM 开关 + 场景级 focus/subset/passline 覆盖）
  const rubricItems = (param.items || []).filter((it) => String(it?.key || '').startsWith('rubric'));
  if (rubricItems.length) {
    lines.push(`- 九尺子参数快照（${rubricItems.length} 项）：`);
    for (const it of rubricItems) {
      const cur = it.current == null ? '未配置' : (typeof it.current === 'object' ? JSON.stringify(it.current) : it.current);
      lines.push(`  - ${it.key}.${it.param}：当前=${cur}（${it.health}/${it.verdict}）`);
    }
  }
  lines.push('');
  lines.push(`---`);
  lines.push(`报告生成时间：${new Date().toISOString()}`);
  return lines.join('\n');
}

// 落盘 .md + upsert nightly_report（独立 catch 由调用方保证；本函数只做 IO）
export async function saveNightlyReport({ retro, routing, param } = {}) {
  const { retro: R, routing: G, param: P } = collectSegments({ retro, routing, param });
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dateCompact = date.replace(/-/g, '');
  const title = `夜批运行报告 ${dateCompact}`;
  const md = renderNightlyMarkdown({ date: dateCompact, retro: R, routing: G, param: P });
  await ensureNightlyReportTable();
  mkdirSync(fileURLToPath(REPORT_DIR), { recursive: true });
  const filePath = new URL(`./${dateCompact}.md`, REPORT_DIR);
  const absPath = fileURLToPath(filePath); // Windows 下须用 fileURLToPath（pathname 会成 /D:/ 双前缀）
  writeFileSync(absPath, md, 'utf8');
  // 统一指标（与渲染一致，兼容实时/持久化两种形态，避免落库回读计数恒 0）
  const RM = extractRetroMetrics(R);
  const rClosed = G.closed || 0;
  const rInsufficient = Array.isArray(G.insufficient) ? G.insufficient.length : 0;
  const rErrors = Array.isArray(G.errors) ? G.errors.length : 0;
  const rPatches = Array.isArray(G.patches) ? G.patches.length : 0;
  const totalTasks = RM.total + (rClosed + rInsufficient + rErrors) + (P.inspected ?? 0);
  const healthy = RM.ok + rClosed + (P.healthy ?? 0);
  const drift = RM.drift + rErrors + (P.drift ?? 0);
  const patchesCount = RM.draftCount + rPatches + (P.patches || []).length;
  await query(
    `INSERT INTO crm.nightly_report (run_date, title, file_path, seg_retro_json, seg_routing_json, seg_param_json, total_tasks, healthy, drift, patches_count, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (run_date) DO UPDATE SET
       title=EXCLUDED.title, file_path=EXCLUDED.file_path, seg_retro_json=EXCLUDED.seg_retro_json,
       seg_routing_json=EXCLUDED.seg_routing_json, seg_param_json=EXCLUDED.seg_param_json,
       total_tasks=EXCLUDED.total_tasks, healthy=EXCLUDED.healthy, drift=EXCLUDED.drift,
       patches_count=EXCLUDED.patches_count, created_at=now()`,
    [date, title, absPath, JSON.stringify(R), JSON.stringify(G), JSON.stringify(P), totalTasks, healthy, drift, patchesCount]
  );
  return { date, filePath: absPath, totalTasks, healthy, drift, patchesCount };
}
