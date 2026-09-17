/**
 * 生成 industry-config.json 的多个 schema 变体，用于定位平台真实校验规则。
 * 变体：
 *   A 完整+元字段+icon 内联 base64（单文件自包含，最可能通过）
 *   B 极简（只保留 slogan/workModes 名称/系统提示词/胶囊名称与提示词）——定位是结构问题还是字段问题
 *   C snake_case 命名 + 元字段 + base64 icon
 * 用法：node scripts/gen-industry-config-variants.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 应用 ID：优先命令行 --app-id=xxx，其次环境变量 BUDDY_APP_ID，最后取 manifest
const argAppId = (process.argv.find((a) => a.startsWith('--app-id=')) || '').split('=')[1];
const APP_ID = argAppId || process.env.BUDDY_APP_ID || '';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'buddy-import', 'variants');
mkdirSync(outDir, { recursive: true });

const m = JSON.parse(readFileSync(join(root, 'buddy-crm-manifest.json'), 'utf8'));
const dataUri = (rel) => {
  const buf = readFileSync(join(root, rel));
  return `data:image/svg+xml;base64,${buf.toString('base64')}`;
};

const appId = APP_ID || m.app.appId;
if (!appId || appId.startsWith('<')) {
  console.error('缺少应用 ID：请传 --app-id=xxx 或设置 BUDDY_APP_ID');
  process.exit(1);
}

const META = {
  appId,
  type: 'industry-config',
  schemaVersion: '1.0',
  version: '1.0.0',
  name: '企业AI销售决策专家',
  industry: { code: 'b2b-sales', name: 'B2B 销售管理', domain: 'CRM' },
  connectors: m.home.connectors,
};

// ---- A：完整 + 元字段 + base64 图标 ----
const A = {
  ...META,
  slogan: m.home.slogan,
  workModes: m.home.workModes.map((w) => ({
    name: w.name,
    icon: dataUri(w.icon),
    default: !!w.default,
    systemPrompt: w.systemPrompt,
    skills: w.skills,
    capsules: w.capsules.map((c) => ({
      name: c.name,
      en: c.en,
      icon: dataUri(c.icon),
      expert: c.expert,
      skills: c.skills,
      systemPrompt: c.systemPrompt,
      prompts: c.prompts,
      inspirations: c.inspirations,
    })),
  })),
};

// ---- B：极简，剔除图标/专家/技能/灵感 ----
// B2 = 极简 + appId（诊断：图标/专家/技能/灵感 是否必填）
const B2 = {
  appId,
  slogan: m.home.slogan,
  workModes: m.home.workModes.map((w) => ({
    name: w.name,
    default: !!w.default,
    systemPrompt: w.systemPrompt,
    capsules: w.capsules.map((c) => ({
      name: c.name,
      en: c.en,
      systemPrompt: c.systemPrompt,
      prompts: c.prompts,
    })),
  })),
};

// ---- C：snake_case + 元字段 + base64 图标 ----
const C = {
  app_id: appId,
  type: 'industry-config',
  schema_version: '1.0',
  version: '1.0.0',
  name: '企业AI销售决策专家',
  industry: { code: 'b2b-sales', name: 'B2B 销售管理', domain: 'CRM' },
  slogan: m.home.slogan,
  connectors: m.home.connectors,
  work_modes: m.home.workModes.map((w) => ({
    name: w.name,
    icon: dataUri(w.icon),
    is_default: !!w.default,
    system_prompt: w.systemPrompt,
    skills: w.skills,
    capsules: w.capsules.map((c) => ({
      name: c.name,
      en: c.en,
      icon: dataUri(c.icon),
      expert: c.expert,
      skills: c.skills,
      system_prompt: c.systemPrompt,
      prompts: c.prompts,
      inspirations: c.inspirations,
    })),
  })),
};

const files = {
  'A-industry-config.json': A,
  'B2-industry-config-minimal-with-appid.json': B2,
  'C-industry-config-snake.json': C,
};
for (const [f, obj] of Object.entries(files)) {
  const p = join(outDir, f);
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  console.log(`${f}  ${(JSON.stringify(obj).length / 1024).toFixed(1)} KB`);
}
console.log('-> dist/buddy-import/variants/');
