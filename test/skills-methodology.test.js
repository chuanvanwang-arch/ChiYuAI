// test/skills-methodology.test.js — G2 方法论 SKILL 注册 + RBAC/enabled 硬闸单测（纯逻辑，不依赖 PG）
// 设计输入：§6.6 方法论以 SKILL 存放；skills/method-* 目录为唯一事实源（registry 仅登记元数据）
// 断言 1：7 个方法论 SKILL 全部注册
// 断言 2：RBAC 硬闸（rbac_roles 白名单）——越权角色被拒、白名单角色放行
// 断言 3：enabled 硬闸（skill_registry.enabled=false → 引擎不装载、市场不暴露）
// 断言 4：目录文件契约——8 文件齐全（SKILL.md/registry.json/methodology.json/core|rules|references|profiles）
import { describe, it, expect, beforeAll } from 'vitest';
import { seedSkills } from '../src/skills/seed.js';
import { getSkill, registerSkill, canExecuteSkill } from '../src/skills/registry.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const METHOD_SLUGS = [
  'method-bant', 'method-meddicc', 'method-opportunity-matrix',
  'method-role-map', 'method-risk-tradeoff', 'method-stop-loss', 'method-fact-vs-script',
];

const AGENT_SKILL_SLUGS = ['crm-native', 'crm-query', 'crm-write', 'crm-risk'];

describe('G2 智能体 SKILL 注册（crm-native/query/write/risk）', () => {
  beforeAll(() => { seedSkills(); });

  it('4 个智能体 SKILL 均注册可 getSkill', () => {
    for (const slug of AGENT_SKILL_SLUGS) {
      expect(getSkill(slug), `${slug} 应已注册`).not.toBeNull();
    }
  });

  it('crm-write 声明两阶段写入（write_two_phase + require_decision_id）', () => {
    const def = getSkill('crm-write');
    expect(def.write_two_phase).toBe(true);
    expect(def.require_decision_id).toBe(true);
  });

  it('crm-risk 声明只读+常驻探测（read_only + proactive_scan）', () => {
    const def = getSkill('crm-risk');
    expect(def.read_only).toBe(true);
    expect(def.proactive_scan).toBe(true);
  });

  it('crm-native 引用 7 个 method-* 子技能（惰性编排依赖）', () => {
    const def = getSkill('crm-native');
    const subs = def.sub_skills || [];
    const methods = subs.filter(s => s.startsWith('method-'));
    expect(methods.length).toBeGreaterThanOrEqual(7);
  });
});

describe('G2 方法论 SKILL 注册（skills/method-*）', () => {
  beforeAll(() => { seedSkills(); });

  it('7 个方法论 SKILL 全部注册且可 getSkill', () => {
    for (const slug of METHOD_SLUGS) {
      expect(getSkill(slug), `${slug} 应已注册`).not.toBeNull();
    }
  });

  it('注册表带 rbac_roles 与 enabled 元数据（skill_registry 契约）', () => {
    for (const slug of METHOD_SLUGS) {
      const def = getSkill(slug);
      expect(Array.isArray(def.rbac_roles), `${slug}.rbac_roles 应为数组`).toBe(true);
      expect(def.rbac_roles.length).toBeGreaterThan(0);
      expect(def.enabled).not.toBe(false); // 未显式 false 即默认开放
    }
  });

  it('目录文件契约：每个 method-* 含 7+ 固定文件（SKILL.md/registry.json/methodology.json + core|rules|references）且 registry 声明的角色有对应 profile', () => {
    for (const slug of METHOD_SLUGS) {
      const base = join(process.cwd(), 'skills', slug);
      const files = [
        'SKILL.md', 'registry.json', 'methodology.json',
        'core/evaluate.md', 'rules/scoring.md', 'references/dimensions.md',
      ];
      for (const f of files) {
        expect(existsSync(join(base, f)), `${slug}/${f} 应存在`).toBe(true);
      }
      // registry 声明的每个 rbac_role 必须有对应 profiles/<role>.md
      const reg = JSON.parse(readFileSync(join(base, 'registry.json'), 'utf8'));
      for (const role of reg.rbac_roles) {
        const pf = join(base, 'profiles', `${role}.md`);
        expect(existsSync(pf), `${slug}/profiles/${role}.md 应存在（registry 声明了 ${role}）`).toBe(true);
      }
    }
  });

  it('registry.json 与 methodology.json 均合法 JSON 且字段齐全', () => {
    for (const slug of METHOD_SLUGS) {
      const base = join(process.cwd(), 'skills', slug);
      for (const jf of ['registry.json', 'methodology.json']) {
        const obj = JSON.parse(readFileSync(join(base, jf), 'utf8'));
        expect(obj, `${slug}/${jf} 可解析`).toBeTruthy();
        expect(obj.methodology_id || obj.name, `${slug}/${jf} 含 methodology_id/name`).toBeTruthy();
      }
    }
  });
});

describe('G2 方法论 SKILL 硬闸（canExecuteSkill）', () => {
  beforeAll(() => { seedSkills(); });

  it('RBAC 白名单：越权角色被拒，白名单角色放行', async () => {
    const def = getSkill('method-bant'); // rbac_roles: ['sales']
    expect(def.rbac_roles).toContain('sales');
    const denied = await canExecuteSkill(def, { role: 'exec' });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('无权执行');
    const allowed = await canExecuteSkill(def, { role: 'sales' });
    expect(allowed.ok).toBe(true);
  });

  it('method-stop-loss 仅 exec/manager 可执行（sales 越权被拒）', async () => {
    const def = getSkill('method-stop-loss'); // rbac_roles: ['exec','manager']
    const denied = await canExecuteSkill(def, { role: 'sales' });
    expect(denied.ok).toBe(false);
    const allowed = await canExecuteSkill(def, { role: 'exec' });
    expect(allowed.ok).toBe(true);
  });

  it('enabled:false 停用硬闸：任何角色均无法执行', async () => {
    registerSkill({ slug: 'method-tmp-disabled', version: 1, steps: [], enabled: false, rbac_roles: ['sales'] });
    const def = getSkill('method-tmp-disabled');
    const gate = await canExecuteSkill(def, { role: 'sales' });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('已停用');
  });
});