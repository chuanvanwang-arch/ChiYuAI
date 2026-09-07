// test/http/approvalFlowLegacyGuard.test.js — approval_flow 遗留表守卫（方案 1 退役收口）
// 设计：docs/2026-09-07-approval-flow-legacy-retire-design.md
// 目的：审批流真源在 CRM_APPROVAL_* 粒子（租户懒克隆隔离）；遗留表 crm.approval_flow 已 DEPRECATED
//（零写路径、只读兼容保留）。本守卫防止遗留表被重新接线（SQL 消费回潮）。
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'dist', 'coverage']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(fp, out); }
    else if (/\.js$/.test(e.name) && !fp.includes(`${ROOT}\\test\\`)) out.push(fp);
  }
  return out;
}

// SQL 消费判定：FROM/INSERT INTO/UPDATE/DELETE FROM + crm.approval_flow（注释性提及不受限）
const CONSUME_RE = /((?:FROM|INTO|UPDATE)\s+crm\.approval_flow)/i;

describe('approval_flow 遗留表守卫（退役收口）', () => {
  it('src/** 无 crm.approval_flow SQL 消费（真源=CRM_APPROVAL_* 粒子）', () => {
    const files = walk(ROOT).filter((f) => f.includes(`${ROOT}\\src\\`));
    expect(files.length).toBeGreaterThan(0); // 扫描面自证非空
    const bad = [];
    for (const f of files) {
      let t; try { t = readFileSync(f, 'utf8'); } catch { continue; }
      if (CONSUME_RE.test(t)) bad.push(f.replace(ROOT, ''));
    }
    expect(bad, `遗留表被重新接线: ${bad.join(', ')}`).toEqual([]);
  });
});
