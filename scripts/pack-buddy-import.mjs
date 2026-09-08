/**
 * 打包 Buddy 应用导入文件包（可直接在开放平台「导入配置」使用）
 * 产物：dist/buddy-import/
 *   ├── industry-config.json   → 导入「industry-config.json」（首页/基础配置：标题+工作模式+场景胶囊+连接器）
 *   ├── market.json            → 导入「market.json」（市场配置：专家/技能/连接器/案例）
 *   ├── assets/                → 模式与胶囊图标（zip 内相对路径与 JSON 引用一致）
 *   └── ../buddy-crm-import.zip → 「导入.zip文件」一键完整包
 * 用法：node scripts/pack-buddy-import.mjs && powershell Compress-Archive ...
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'buddy-import');
const manifest = JSON.parse(readFileSync(join(root, 'buddy-crm-manifest.json'), 'utf8'));

mkdirSync(join(outDir, 'assets', 'modes'), { recursive: true });
mkdirSync(join(outDir, 'assets', 'capsules'), { recursive: true });

// 1) industry-config.json：首页/基础配置（导入后落到「基础配置 + 首页配置」）
const industryConfig = {
  slogan: manifest.home.slogan,
  workModes: manifest.home.workModes.map((w) => ({
    name: w.name,
    icon: w.icon,
    default: !!w.default,
    systemPrompt: w.systemPrompt,
    skills: w.skills,
    capsules: w.capsules.map((c) => ({
      name: c.name,
      en: c.en,
      icon: c.icon,
      expert: c.expert,
      skills: c.skills,
      systemPrompt: c.systemPrompt,
      prompts: c.prompts,
      inspirations: c.inspirations,
    })),
  })),
  connectors: manifest.home.connectors,
};
writeFileSync(join(outDir, 'industry-config.json'), JSON.stringify(industryConfig, null, 2), 'utf8');

// 2) market.json：市场配置（专家/技能/连接器/案例；技能取已上架全集）
const availableSkills = readdirSync(join(root, 'connector', 'skills')).sort();
const market = {
  experts: manifest.market.experts,
  skills: availableSkills,
  connectors: manifest.market.connectors,
  cases: manifest.market.cases,
};
writeFileSync(join(outDir, 'market.json'), JSON.stringify(market, null, 2), 'utf8');

// 3) 图标资源：zip 内相对路径与 JSON 中 icon 字段一致
cpSync(join(root, 'assets', 'modes'), join(outDir, 'assets', 'modes'), { recursive: true });
cpSync(join(root, 'assets', 'capsules'), join(outDir, 'assets', 'capsules'), {
  recursive: true,
  filter: (s) => !s.endsWith('index.html'),
});
const avatar = join(root, 'buddy-app-store-listing', 'app-avatar.png');
if (existsSync(avatar)) cpSync(avatar, join(outDir, 'assets', 'app-avatar.png'));

// 4) 校验：JSON 引用的 icon 必须都在包内
const missing = [];
for (const w of industryConfig.workModes) {
  if (!existsSync(join(outDir, w.icon))) missing.push(w.icon);
  for (const c of w.capsules) if (!existsSync(join(outDir, c.icon))) missing.push(c.icon);
}
if (missing.length) {
  console.error('MISSING ICONS:\n' + missing.join('\n'));
  process.exit(1);
}
const capsuleCount = industryConfig.workModes.reduce((n, w) => n + w.capsules.length, 0);
console.log(`industry-config.json: ${industryConfig.workModes.length} 模式 / ${capsuleCount} 胶囊`);
console.log(`market.json: ${market.experts.length} 专家 / ${market.skills.length} 技能 / ${market.connectors.length} 连接器`);
console.log(`assets: modes ${readdirSync(join(outDir, 'assets', 'modes')).length} + capsules ${readdirSync(join(outDir, 'assets', 'capsules')).length}`);
console.log('OK -> dist/buddy-import/ （下一步用 Compress-Archive 打 zip）');
