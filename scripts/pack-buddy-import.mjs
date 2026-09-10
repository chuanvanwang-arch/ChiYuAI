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

const argAppId = (process.argv.find((a) => a.startsWith('--app-id=')) || '').split('=')[1];
const APP_ID = argAppId || process.env.BUDDY_APP_ID || '';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'buddy-import');
const manifest = JSON.parse(readFileSync(join(root, 'buddy-crm-manifest.json'), 'utf8'));

mkdirSync(join(outDir, 'assets', 'modes'), { recursive: true });
mkdirSync(join(outDir, 'assets', 'capsules'), { recursive: true });

// 1) industry-config.json：已验证可通过格式校验的结构（appId + 元字段 + 图标内联 base64）
const appId = APP_ID || manifest.app.appId;
if (!appId || appId.startsWith('<')) {
  console.error('缺少应用 ID：请传 --app-id=xxx 或设置 BUDDY_APP_ID');
  process.exit(1);
}
const dataUri = (rel) =>
  `data:image/svg+xml;base64,${readFileSync(join(root, rel)).toString('base64')}`;

const industryConfig = {
  appId,
  type: 'industry-config',
  schemaVersion: '1.0',
  version: '1.0.0',
  name: manifest.app.name,
  industry: { code: 'b2b-sales', name: 'B2B 销售管理', domain: 'CRM' },
  slogan: manifest.home.slogan,
  connectors: manifest.home.connectors,
  workModes: manifest.home.workModes.map((w) => ({
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

// 4) 校验：图标源文件存在、appId 已写入
const missing = [];
for (const w of manifest.home.workModes) {
  if (!existsSync(join(root, w.icon))) missing.push(w.icon);
  for (const c of w.capsules) if (!existsSync(join(root, c.icon))) missing.push(c.icon);
}
if (missing.length) {
  console.error('MISSING ICONS:\n' + missing.join('\n'));
  process.exit(1);
}
if (!industryConfig.appId) {
  console.error('appId 为空');
  process.exit(1);
}
const capsuleCount = industryConfig.workModes.reduce((n, w) => n + w.capsules.length, 0);
console.log(`industry-config.json: ${industryConfig.workModes.length} 模式 / ${capsuleCount} 胶囊`);
console.log(`market.json: ${market.experts.length} 专家 / ${market.skills.length} 技能 / ${market.connectors.length} 连接器`);
console.log(`assets: modes ${readdirSync(join(outDir, 'assets', 'modes')).length} + capsules ${readdirSync(join(outDir, 'assets', 'capsules')).length}`);
console.log('OK -> dist/buddy-import/ （下一步用 Compress-Archive 打 zip）');
