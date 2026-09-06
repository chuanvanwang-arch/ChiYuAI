import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedProfiles, loadProfile } from '../../src/context/roleProfiles.js';

// 用拼接构造被禁字符串，避免本测试源文件自身含字面量导致自引用失败
const FORBIDDEN = 'sys' + '-admin';
const ROOT = process.cwd();
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'dist', 'coverage']);
const EXCLUDE_FILES = new Set([
  'test/role/sysadmin-profile.test.js', // 本测试自身不应被自己扫描
  'db/2026-09-04-skill-registry-rbac-fix.sql', // 迁移修正必须保留旧连字符角色名作为被替换目标
  'docs/2026-09-04-sysadmin-role-tenant-attribution-design.md',
  'docs/superpowers/plans/2026-09-04-sysadmin-role-tenant-attribution.md',
  'src/http/middleware/rbac.js', // 运行时别名归一：有意保留 sys-admin 映射到 SYSADMIN
  'test/propagation/permission.test.js', // 测试上述别名归一行为
]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, e.name);
    const rel = fp.slice(ROOT.length + 1).replace(/\\/g, '/');
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(fp, out); }
    else if (/\.(js|json|sql|html|py|ts|mjs|md)$/.test(e.name) && !EXCLUDE_FILES.has(rel)) out.push(fp);
  }
  return out;
}

describe('sysadmin 缺省角色', () => {
  it('role_context_profile 含 sysadmin 且 data_scope=all + write_scope=governance', async () => {
    await seedProfiles();
    const p = await loadProfile('sysadmin');
    expect(p).not.toBeNull();
    expect(p.data_scope.model).toBe('all');
    // F4 方案 C：写范围收敛为治理类（业务粒子写拒、治理类写放行），读保持全量
    expect(p.data_scope.write_scope.model).toBe('governance');
  });
  it('运行期文件无旧连字符角色名残留（统一为 sysadmin）', () => {
    const files = walk(ROOT);
    const bad = [];
    for (const f of files) {
      let t; try { t = readFileSync(f, 'utf8'); } catch { continue; }
      if (t.includes(FORBIDDEN)) bad.push(f.replace(ROOT, ''));
    }
    expect(bad, `仍存在旧连字符角色名残留: ${bad.join(', ')}`).toEqual([]);
  });
});
