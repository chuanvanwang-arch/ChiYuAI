#!/usr/bin/env node
/**
 * 测试隔离完整性审计（test-isolation-audit）
 *
 * 背景：2026-09-02 全量测试暴露 `test/calibration/replayDims.test.js` 的真缺陷——
 * `beforeEach` 只 `DELETE FROM crm.decision`（按 scenario_id 范围删），不清理 9 张
 * FK 子表，导致上游业务代码（`autonomyEngine.js` 的 `requireDecision` 升级人工路径）
 * 造的 decision_event 残留撞 `decision_event_decision_id_fkey`。
 *
 * 判据（本脚本固化的核心知识）：
 *   - 按【主键/唯一键】精确删「自己刚裸插入的行」→ 安全（无子表引用）；
 *   - 按【范围】删（scenario_id / 时间窗 / 类型 / 全表）→ 会捞到业务代码或其它文件
 *     造的行，必须按「子表 → 主表」清理，否则撞 FK；
 *   - 子表 FK 为 ON DELETE CASCADE → 删主表时子表自动级联清理，无需手动清（2026-09-03 补：
 *     实测 crm.task_audit.task_id REFERENCES crm.tasks ON DELETE CASCADE，两个事件触发测试
 *     的按键 DELETE 被判误报高危，导致 pretest --strict 锁死全量回归）。
 *
 * 用法：
 *   node scripts/test-isolation-audit.mjs            # 审计 test/ 目录
 *   node scripts/test-isolation-audit.mjs --strict   # 有 🔴 高危即 exit 1（供 CI 用）
 *
 * 注意：本脚本只读测试库 crm_native_test，拒绝连生产库。
 */

const FORCED_DB = 'crm_native_test';
if (process.env.PGDATABASE === 'crm_native' || process.env.PGDATABASE === 'plm') {
  console.error(`[test-isolation-audit] 拒绝执行：PGDATABASE=${process.env.PGDATABASE} 为生产库。`);
  process.exit(1);
}
process.env.PGDATABASE = process.env.PGDATABASE || FORCED_DB;

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');

// 逃生阀：确认无隔离缺陷、或审计脚本自身故障需要绕过时设 SKIP_ISOLATION_AUDIT=1。
//   pretest 已接入本脚本（严格模式），没有逃生阀会把整条测试链锁死。
if (process.env.SKIP_ISOLATION_AUDIT === '1') {
  console.log('[test-isolation-audit] 已按 SKIP_ISOLATION_AUDIT=1 跳过。');
  process.exit(0);
}

// ---------- 1. 读取 schema 元数据：FK 关系（含 delete_rule）+ 主键 ----------

async function loadSchemaMeta(client) {
  const fk = (await client.query(`
    SELECT DISTINCT
           ccu.table_name  AS parent_table,
           tc.table_name   AS child_table,
           kcu.column_name AS child_column,
           rc.delete_rule  AS delete_rule
      FROM information_schema.table_constraints      tc
      JOIN information_schema.key_column_usage       kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema    = ccu.constraint_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.constraint_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema    = 'crm'
       AND ccu.table_schema   = 'crm'
     ORDER BY ccu.table_name, tc.table_name
  `)).rows;

  const pk = (await client.query(`
    SELECT kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage  kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema    = 'crm'
  `)).rows;

  const childrenOf = new Map(); // parent -> [{child, column, delete_rule}]
  for (const r of fk) {
    if (!childrenOf.has(r.parent_table)) childrenOf.set(r.parent_table, []);
    childrenOf.get(r.parent_table).push({ child: r.child_table, column: r.child_column, delete_rule: r.delete_rule });
  }
  const pkOf = new Map(); // table -> Set(主键列)
  for (const r of pk) {
    if (!pkOf.has(r.table_name)) pkOf.set(r.table_name, new Set());
    pkOf.get(r.table_name).add(r.column_name);
  }
  return { childrenOf, pkOf };
}

// ---------- 2. 扫描测试文件中的 DELETE 语句 ----------

// 表名后必须跟空白/分号/换行，避免把 `crm.decision` 的 schema 名 `crm` 误当表名
const RE_DELETE = /DELETE\s+FROM\s+(?:crm\.)?([a-z_][a-z0-9_]*)(?=[\s;)\n])([\s\S]{0,300}?)(?:;|`|\n\s*\n|$)/gi;

/** 剥离 JS 注释（保留字符位置，避免行号漂移）。注释里的示例代码不得被当真实语句。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
}

/**
 * 收集显式豁免标记（把「已人工判定安全」固化在代码里，避免每次全量后重复排查）：
 *   // isolation-audit:ignore              → 豁免整个文件
 *   // isolation-audit:ignore crm.decision → 只豁免指定表（可空格分隔多个）
 *   冒号后其余文字作为理由，会在报告中回显。
 */
const RE_IGNORE = /isolation-audit:ignore((?:\s+(?:crm\.)?[a-z_][a-z0-9_]*)*)([^\n]*)/gi;
function collectIgnores(src) {
  let all = false;
  const tables = new Set();
  const reasons = [];
  let m;
  RE_IGNORE.lastIndex = 0;
  while ((m = RE_IGNORE.exec(src))) {
    const names = (m[1] || '').trim().split(/\s+/).filter(Boolean).map((s) => s.replace(/^crm\./, ''));
    const firstLine = (m[2] || '').trim().replace(/^[—–\-:：]+/, '').trim();
    // 续行：其后连续的 // 注释行同属该理由（最多 3 行，避免吞掉整个注释块）
    const rest = src.slice(m.index + m[0].length).split('\n');
    const cont = [];
    for (let i = 1; i < rest.length && cont.length < 3; i++) {
      const t = rest[i].trim();
      if (!t.startsWith('//')) break;
      cont.push(t.replace(/^\/\/\s?/, ''));
    }
    let reason = [firstLine, ...cont].filter(Boolean).join(' ');
    if (reason.length > 200) reason = reason.slice(0, 200) + '…';
    if (names.length === 0) all = true;
    else for (const t of names) tables.add(t);
    if (reason) reasons.push(reason);
  }
  return { all, tables, reasons };
}

/** 识别 `DELETE FROM crm.${var}` 动态表名：从同文件 `for (const var of ['a','b'])` 提取取值集合 */
function collectDynamicTables(src) {
  const out = new Set();
  const arrays = new Map(); // varName -> [表名]
  const reFor = /for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s*\[([^\]]*)\]/g;
  let mm;
  while ((mm = reFor.exec(src))) {
    const names = [...mm[2].matchAll(/['"`]([a-z_][a-z0-9_]*)['"`]/g)].map((x) => x[1]);
    arrays.set(mm[1], names);
  }
  const reDyn = /DELETE\s+FROM\s+crm\.\$\{(\w+)\}/gi;
  while ((mm = reDyn.exec(src))) {
    for (const t of arrays.get(mm[1]) || []) out.add(t);
  }
  return out;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 判定删除类别：
 *   'full'     无 WHERE（全表删，核弹）
 *   'precise'  WHERE 命中主键/唯一键的等值匹配
 *   'range'    其它（范围删）
 */
function classifyDelete(table, tail, pkOf) {
  const m = /\bWHERE\b([\s\S]*)$/i.exec(tail);
  if (!m) return 'full';
  const where = m[1];

  // 等值/IN/ANY 匹配到的列名
  const matchedCols = new Set();
  const reCol = /([a-z_][a-z0-9_]*)\s*(?:=|IN\s*\(|=\s*ANY\s*\()/gi;
  let mm;
  while ((mm = reCol.exec(where))) matchedCols.add(mm[1].toLowerCase());

  const pks = pkOf.get(table);
  if (pks) for (const c of pks) if (matchedCols.has(c)) return 'precise';

  // 兜底：<表名单数>_id 等值（主键未被 information_schema 捕获时的启发式）
  const guess = table.replace(/(ies)$/, 'y').replace(/s$/, '') + '_id';
  if (matchedCols.has(guess) || matchedCols.has('id')) return 'precise';

  return 'range';
}

// ---------- 3. 主流程 ----------

const { pool } = await import('../src/db.js');

async function main() {
  const { childrenOf, pkOf } = await loadSchemaMeta(pool);
  const files = walk(path.join(ROOT, 'test'));

  const findings = []; // {file, table, kind, risk, missing[]}

  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const ign = collectIgnores(fs.readFileSync(file, 'utf8')); // 豁免标记本身是注释，需读原文

    // 第一遍：收集该文件涉及的所有 DELETE 目标表（子表 DELETE 可能写在主表之后，
    //         若边扫边判会把「先删主表后删子表」误判为缺失清理）
    const deletedTables = new Set();
    RE_DELETE.lastIndex = 0;
    let m0;
    while ((m0 = RE_DELETE.exec(src))) deletedTables.add(m0[1]);
    // 动态表名（表驱动清理子表的常见写法）一并计入，否则会把已清理判成缺失
    for (const t of collectDynamicTables(src)) deletedTables.add(t);

    // 第二遍：逐条判定
    RE_DELETE.lastIndex = 0;
    let m;
    while ((m = RE_DELETE.exec(src))) {
      const table = m[1];
      const tail = m[2];
      const kind = classifyDelete(table, tail, pkOf);

      const children = childrenOf.get(table) || [];
      // CASCADE 子表无需手动清理（删主表时自动级联）；只有 NO ACTION / RESTRICT 子表才是硬约束
      const missing = children.filter((c) => !deletedTables.has(c.child) && c.delete_rule !== 'CASCADE');

      let risk;
      const waived = ign.all || ign.tables.has(table);
      if (waived) risk = 'waived'; // 已人工判定安全并显式标记
      else if (children.length === 0) risk = 'none'; // 无 FK 子表，删了不会撞约束
      else if (kind === 'precise') risk = 'ok'; // 精确删自己的行，无子表引用
      else if (missing.length === 0) risk = 'ok'; // 范围删但子表都清了（CASCADE 子表不要求手动清）
      else risk = 'high';

      findings.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        table,
        kind,
        risk,
        totalChildren: children.length,
        missing: missing.map((c) => c.child),
        reason: ign.reasons.join(' / '),
      });
    }
  }

  // ---------- 输出报告 ----------
  const high = findings.filter((f) => f.risk === 'high');
  const ok = findings.filter((f) => f.risk === 'ok');
  const none = findings.filter((f) => f.risk === 'none');
  const waived = findings.filter((f) => f.risk === 'waived');
  const full = findings.filter((f) => f.kind === 'full' && f.risk !== 'waived');

  console.log('══════════ 测试隔离完整性审计 ══════════');
  console.log(`扫描测试文件：${files.length} 个；DELETE 语句：${findings.length} 条`);
  console.log(`  有 FK 子表且清理完整：${ok.length}`);
  console.log(`  无 FK 子表（仅孤儿风险）：${none.length}`);
  console.log(`  已显式豁免（人工判定安全）：${waived.length}`);
  console.log(`  🔴 高危（范围删但未清子表）：${high.length}`);
  console.log('');

  // 按 文件|表 聚合（同一表可能有多条 DELETE），kind 取最严重：full > range > precise
  const SEVERITY = { precise: 0, range: 1, full: 2 };
  function aggregate(list) {
    const map = new Map();
    for (const f of list) {
      const k = f.file + '|' + f.table;
      const prev = map.get(k);
      if (!prev) { map.set(k, { ...f, missing: new Set(f.missing) }); continue; }
      if (SEVERITY[f.kind] > SEVERITY[prev.kind]) prev.kind = f.kind;
      for (const c of f.missing) prev.missing.add(c);
    }
    return [...map.values()];
  }

  if (high.length) {
    console.log('── 🔴 高危：范围/全表删主表，但 FK 子表未清理（会撞外键）──');
    for (const f of aggregate(high)) {
      console.log(`  ${f.file}`);
      console.log(`      表 crm.${f.table}（${f.kind === 'full' ? '全表删' : '范围删'}）→ 未清理子表：${[...f.missing].join(', ')}`);
    }
    console.log('');
  }

  if (full.length) {
    console.log('── ⚠ 全表删（无 WHERE）：即便当前无 FK 子表，也是核弹式清理，会抹掉基线 seed ──');
    for (const f of aggregate(full)) {
      console.log(`  ${f.file}  →  crm.${f.table}`);
    }
    console.log('');
  }

  if (waived.length) {
    console.log('── ⚪ 已显式豁免（形态高危但人工判定安全，理由见注释）──');
    for (const f of aggregate(waived)) {
      console.log(`  ${f.file}  →  crm.${f.table}`);
      if (f.reason) console.log(`      理由：${f.reason}`);
    }
    console.log('');
  }

  if (!high.length && !full.length) {
    console.log('✅ 未发现高危隔离缺陷。');
  }

  await pool.end();
  if (STRICT && (high.length || full.length)) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error('[test-isolation-audit] 执行失败：', e.message);
  process.exit(1);
});
