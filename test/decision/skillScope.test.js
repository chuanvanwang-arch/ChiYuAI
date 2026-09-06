// P3 D2 单测：三层作用域归并（纯函数，不依赖 DB）
import { describe, it, expect } from 'vitest';
import { resolveEffectiveSkills, SCOPE_LEVELS } from '../../src/skill/skillScope.js';

const ROWS = [
  { skill: 's1', scope_level: 'system', owner: null, enabled: true, promoted_from: null },
  { skill: 's1', scope_level: 'workspace', owner: 'ws-a', enabled: false, promoted_from: null }, // workspace 关掉
  { skill: 's2', scope_level: 'system', owner: null, enabled: false, promoted_from: null }, // 系统层关
  { skill: 's2', scope_level: 'user', owner: 'u-a', enabled: true, promoted_from: 'user' }, // 用户层开
  { skill: 's3', scope_level: 'workspace', owner: 'ws-b', enabled: true, promoted_from: null }, // 仅 workspace 有
];

describe('SCOPE_LEVELS', () => {
  it('三层合法值', () => {
    expect(SCOPE_LEVELS).toEqual(['system', 'workspace', 'user']);
  });
});

describe('resolveEffectiveSkills 优先级归并', () => {
  it('user > workspace > system：s1 workspace 显式关 → 高层 override 系统层开（disable 也生效）', () => {
    const eff = resolveEffectiveSkills(ROWS, { workspace: 'ws-a', user: 'u-a' });
    expect(eff.get('s1').enabled).toBe(false); // workspace 显式关，覆盖 system 开
    expect(eff.get('s1').scope_level).toBe('workspace');
  });
  it('s1 在 ws-x 上下文（workspace 不匹配）→ 落回 system(开)', () => {
    const eff = resolveEffectiveSkills(ROWS, { workspace: 'ws-x', user: 'u-a' });
    expect(eff.get('s1').enabled).toBe(true); // ws-x 无 s1 workspace 行 → 系统层生效
    expect(eff.get('s1').scope_level).toBe('system');
  });
  it('s2 user 开覆盖 system 关', () => {
    const eff = resolveEffectiveSkills(ROWS, { workspace: 'ws-a', user: 'u-a' });
    expect(eff.get('s2').enabled).toBe(true);
    expect(eff.get('s2').scope_level).toBe('user');
    expect(eff.get('s2').promoted_from).toBe('user');
  });
  it('仅 workspace 存在的 skill 生效（须匹配 scope.workspace）', () => {
    const eff = resolveEffectiveSkills(ROWS, { workspace: 'ws-b', user: 'u-a' });
    expect(eff.get('s3').enabled).toBe(true);
    expect(eff.get('s3').scope_level).toBe('workspace');
  });
  it('workspace 行不匹配当前 workspace 则忽略（避免跨租户串扰）', () => {
    const eff = resolveEffectiveSkills(ROWS, { workspace: 'ws-x', user: 'u-a' });
    expect(eff.has('s3')).toBe(false);
  });
});
