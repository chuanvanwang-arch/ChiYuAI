// test/skill-seed-4.test.js — 4 个业务角色 SKILL seed 登记
import { describe, it, expect, beforeEach } from 'vitest';
import { seedSkills } from '../src/skills/seed.js';
import { getSkill } from '../src/skills/registry.js';

describe('4 个业务角色 SKILL seed 登记', () => {
  beforeEach(() => seedSkills());

  it('method-intake-routing 已登记', () => {
    expect(getSkill('method-intake-routing')).not.toBeNull();
  });
  it('method-quote-engine 已登记', () => {
    expect(getSkill('method-quote-engine')).not.toBeNull();
  });
  it('method-followup-engine 已登记', () => {
    expect(getSkill('method-followup-engine')).not.toBeNull();
  });
  it('method-review-gate 已登记', () => {
    expect(getSkill('method-review-gate')).not.toBeNull();
  });
});