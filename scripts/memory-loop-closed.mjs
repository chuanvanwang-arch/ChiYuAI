// scripts/memory-loop-closed.mjs — §13 治理闭环：巡检缺口 → 累积复发 → 生成改进提案（待人工评审）
//
// 闭环逻辑（docs/2026-09-10-memory-system-governance-design.md §8 / §13）：
//   巡检(health-check) → 缺口入 feedback.json → 同一 gap_type 复发 ≥ MIN_OCC(默认2) →
//   在 proposals.json 生成一条改进提案。**提案仅落盘供人工评审，绝不在本脚本内自动执行**（HITL 闸）。**
//
// 用法：
//   node scripts/memory-loop-closed.mjs                         # 跑巡检 + 更新闭环状态
//   node scripts/memory-loop-closed.mjs --report=health.json   # 复用既有巡检 JSON（不重新连库）
//   node scripts/memory-loop-closed.mjs --min-occ=3            # 调高复发阈值
//   PGDATABASE=crm_native node scripts/memory-loop-closed.mjs   # 对生产库闭环
//
// 铁律：本脚本只 SELECT + 写 feedback/proposals 两个 JSON 文件，不触达 memory_log、不跑 UPDATE/DELETE。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const PGDATABASE = process.env.PGDATABASE || 'crm_native';
const MIN_OCC = Number(process.argv.find((a) => a.startsWith('--min-occ='))?.split('=')[1]) || 2;
const reportArg = process.argv.find((a) => a.startsWith('--report='))?.split('=')[1];

const FEEDBACK = join(__dir, '..', '.workbuddy', 'memory', 'memory-loop-feedback.json');
const PROPOSALS = join(__dir, 'memory-loop-proposals.json');

// gap_type → 已知修复动作（映射治理设计文档 §12 的修补脚本步骤；仅描述，不执行）
const REMEDIATION = {
  'tenant-writeback': '运行 memory-backfill.mjs --step=tenant --apply（S2：join decision 反查真实 tenant_id）',
  'entity-anchor': '运行 memory-backfill.mjs --step=anchor --apply（S3：payload.account_id 提升至 entity_id/entity_type）',
  'decision-projection': '运行 memory-backfill.mjs --step=project --apply（S4：C7 四段式投影重放，只加键不删键）',
  'inject-empty': '核查 C7 投影是否覆盖所有写路径；确认 entity_type/summary 已写入，避免 injector.memoryText 过滤成空串',
  'noise-flood': '运行 memory-backfill.mjs --step=noise --apply（S1：event:trace:* 软删归档）；并确认 capture 白名单(C4)已上线',
  'noise-live': '先修 capture 白名单(C4)，源头切断后再谈存量修补；否则边补边污染',
  'decision-tenant': '确认 C5+C8 已上线（mint 与先例检索均传 tenantId）；对生产历史决策跑回填',
};

// 1) 取得巡检报告（复用或重跑）
let report;
if (reportArg && existsSync(reportArg)) {
  report = JSON.parse(readFileSync(reportArg, 'utf8'));
  console.log(`复用既有巡检报告 ${reportArg}`);
} else {
  const tmp = join(__dir, '.health-check-tmp.json');
  console.log('运行 health-check 取最新缺口…');
  execFileSync('node', ['scripts/memory-health-check.mjs', '--json', tmp], { stdio: 'inherit', env: { ...process.env, PGDATABASE } });
  report = JSON.parse(readFileSync(tmp, 'utf8'));
}
const gaps = report.gaps || [];
console.log(`巡检@${report.at} | 库=${report.db} | 缺口 ${gaps.length} 项\n`);

// 2) 读取/初始化 feedback（缺口复发账本）
const now = new Date().toISOString();
let fb = existsSync(FEEDBACK) ? JSON.parse(readFileSync(FEEDBACK, 'utf8')) : { gaps: {} };
fb.gaps ||= {};
const seen = new Set(gaps.map((g) => g.type));

for (const g of gaps) {
  const e = fb.gaps[g.type] || { occurrences: 0, first_seen: now, detail: g.detail, proposed: false };
  e.occurrences += 1;
  e.last_seen = now;
  e.detail = g.detail;
  fb.gaps[g.type] = e;
}
// 不在本轮缺口里的项，保持其历史计数（不衰减，便于跨夜批观察趋势）
for (const [type, e] of Object.entries(fb.gaps)) {
  if (!seen.has(type)) e.stale = true;
}

// 3) 复发 ≥ MIN_OCC 且未生成过提案 → 落提案（仅描述，待人工评审）
let proposals = existsSync(PROPOSALS) ? JSON.parse(readFileSync(PROPOSALS, 'utf8')) : [];
let newCount = 0;
for (const [type, e] of Object.entries(fb.gaps)) {
  if (e.occurrences >= MIN_OCC && !e.proposed) {
    const p = {
      id: `prop-${type}-${now.slice(0, 10)}`,
      gap_type: type,
      occurrences: e.occurrences,
      first_seen: e.first_seen,
      last_seen: e.last_seen,
      detail: e.detail,
      remediation: REMEDIATION[type] || '（暂无映射的修复动作，请人工研判）',
      status: 'pending-review', // 仅待评审；执行需人工在终端跑对应 backfill 步骤
      created_at: now,
    };
    proposals.push(p);
    e.proposed = true;
    newCount += 1;
  }
}

writeFileSync(FEEDBACK, JSON.stringify(fb, null, 2));
writeFileSync(PROPOSALS, JSON.stringify(proposals, null, 2));

console.log('── 闭环状态 ──');
for (const [type, e] of Object.entries(fb.gaps)) {
  const flag = e.occurrences >= MIN_OCC ? (e.proposed ? '⚑已提案' : '⚠达标未提案') : '·观察';
  console.log(`  ${flag}  ${type.padEnd(20)} 复发 ${e.occurrences} 次`);
}
console.log(`\n新增提案 ${newCount} 条 → ${PROPOSALS}`);
console.log('提案均为 pending-review，需人工在终端执行对应 backfill 步骤后方可生效（本脚本不触达 memory_log）。');
