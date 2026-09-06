// test/skills-seed.js — 独立种子运行器（非 vitest 测试，手动执行：node test/skills-seed.js）
// 注入 Action Registry + SKILL 表，打印注册结果，供排障/启动前自检
import { seedActions } from '../src/action/seed-actions.js';
import { seedSkills } from '../src/skills/seed.js';
import { listActions } from '../src/action/registry.js';
import { getSkill } from '../src/skills/registry.js';

seedActions();
seedSkills();
console.log('actions:', listActions().map(a => a.name).join(', '));
const EXPECTED_SKILLS = [
  'crm-deal-analyze', 'crm-skill-fallback',
  'method-bant', 'method-meddicc', 'method-opportunity-matrix',
  'method-role-map', 'method-risk-tradeoff', 'method-stop-loss', 'method-fact-vs-script',
  'crm-native', 'crm-query', 'crm-write', 'crm-risk',
];
console.log('skills :', EXPECTED_SKILLS
  .map(s => `${s}=${getSkill(s) ? 'ok' : 'MISSING'}`).join('  '));
const missing = EXPECTED_SKILLS.filter(s => !getSkill(s));
if (missing.length) { console.error('MISSING SKILLS:', missing.join(', ')); process.exitCode = 1; }
