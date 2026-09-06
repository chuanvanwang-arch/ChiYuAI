import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const tm = readFileSync('src/web/tenant-management.html', 'utf8');
const landing = readFileSync('src/web/landing.html', 'utf8');

describe('租户管理/自助注册页冒烟', () => {
  it('租户管理页含创建者列与按创建者筛选框', () => {
    expect(tm).toContain('创建者');
    expect(tm).toContain('tm-filter');
    expect(tm).toContain('created_by_username');
  });
  it('自助注册页含推荐者输入框', () => {
    expect(landing).toContain('r_referrer');
    expect(landing).toContain('referrer');
  });
});
