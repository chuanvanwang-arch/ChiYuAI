/**
 * 按平台导出的真实 schema（样本见 dist/buddy-export-sample 下以应用 ID 命名的目录）生成可导入配置。
 *
 * 真实结构要点：
 *   industry-config.json → templateId / version(数字) / brand{title,logo} /
 *                          ui.nav.items[].config.{header,modes.items} / i18n.source / models / authConfig
 *   market.json          → templateId / version / body(市场分类树 domain→collection→category)
 *
 * 图标策略 --icons=inline(默认,base64 data URI) | empty(留空,导入后在 UI 手传) | path(assets 相对路径)
 * 用法：node scripts/gen-buddy-config-v2.mjs [--app-id=cb_xxx] [--icons=empty]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sampleDir = join(root, 'dist', 'buddy-export-sample');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const manifest = JSON.parse(readFileSync(join(root, 'buddy-crm-manifest.json'), 'utf8'));
const ICONS = arg('icons', 'inline');
const APP_ID = arg('app-id', manifest.app.appId);

// 读取平台导出的真实样本作为骨架（保证字段与结构一致）
const samplePath = join(sampleDir, APP_ID);
const sampleIndustry = JSON.parse(readFileSync(join(samplePath, 'industry-config.json'), 'utf8'));
const sampleMarket = JSON.parse(readFileSync(join(samplePath, 'market.json'), 'utf8'));

const dataUri = (rel) =>
  `data:image/svg+xml;base64,${readFileSync(join(root, rel)).toString('base64')}`;
const iconOf = (rel) => (ICONS === 'inline' ? dataUri(rel) : ICONS === 'path' ? rel : '');

// 别名冗余：平台内部字段名未公开（导出样本里 modes.items 为空数组），
// 同一份数据用多个候选名各写一份，任一命中即可被识别。
const ALIAS = arg('alias', 'on') === 'on';
const aMode = (base) => (ALIAS ? { ...base, title: base.name, label: base.name, isDefault: base.default } : base);
const aCapsule = (base) =>
  ALIAS
    ? {
        ...base,
        title: base.name,
        label: base.name,
        nameEn: base.en,
        enName: base.en,
        prompt: base.systemPrompt,
        templates: base.prompts,
        promptTemplates: base.prompts,
      }
    : base;

// ---------- industry-config.json ----------
const cfg = structuredClone(sampleIndustry);
cfg.templateId = APP_ID;
cfg.version = 1;

// brand：保留应用名 key，标题文本沿用平台现有值（不擅自改应用名）
cfg.i18n = {
  defaultLocale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  source: {
    'zh-CN': {
      ...sampleIndustry.i18n?.source?.['zh-CN'],
      'home.header.title': manifest.home.slogan, // 首页标题（≤25 字）
    },
  },
};

const homeItem = cfg.ui.nav.items.find((i) => i.id === 'home') || cfg.ui.nav.items[0];
homeItem.config.header = { visible: true, title: 'home.header.title' };
const capsulesOf = (w) =>
  w.capsules.map((c, ci) =>
    aCapsule({
      id: `${w.id}-${ci + 1}`,
      name: c.name,
      en: c.en,
      icon: iconOf(c.icon),
      expert: c.expert,
      skills: c.skills,
      systemPrompt: c.systemPrompt,
      prompts: c.prompts,
      inspirations: c.inspirations,
    })
  );

homeItem.config.modes = {
  items: manifest.home.workModes.map((w, wi) => {
    const caps = capsulesOf(w);
    const base = {
      id: w.id,
      name: w.name,
      icon: iconOf(w.icon),
      default: !!w.default,
      order: (wi + 1) * 10,
      systemPrompt: w.systemPrompt,
      skills: w.skills,
      capsules: caps,
    };
    return ALIAS ? { ...aMode(base), promptTemplates: caps, sceneCapsules: caps } : base;
  }),
};

// authConfig：本应用经 MCP 连接器接入
cfg.authConfig = {
  mcpOnly: true,
  skipJump: false,
  capabilityDescription:
    'AI 原生销售管理：客户 360、商机阶段推进、报价与折扣审批、风险预警、复盘归因，经 crm-native MCP 连接器接入。',
};

// ---------- market.json ----------
// 分类树为平台维护的结构，保持不变；仅更新名称与描述
const mkt = structuredClone(sampleMarket);
mkt.templateId = APP_ID;
mkt.body.id = APP_ID;
mkt.body.name = { zh: sampleIndustry.i18n?.source?.['zh-CN']?.['brand.title'] || 'AI 原生销售管理助手' };
mkt.body.description = {
  zh: '销售方法即问即得、阶段自动推进、AI 自主销售决策、客户永久记忆；内置 BANT / MEDDICC / 漏斗分类 / 止损等方法论。',
};

// ---------- 输出 ----------
const outName =
  (ICONS === 'inline' ? 'buddy-import-v2' : `buddy-import-v2-${ICONS}`) + (ALIAS ? '-alias' : '');
const outDir = join(root, 'dist', outName, APP_ID);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'industry-config.json'), JSON.stringify(cfg, null, 2), 'utf8');
writeFileSync(join(outDir, 'market.json'), JSON.stringify(mkt, null, 2), 'utf8');

const capsuleCount = manifest.home.workModes.reduce((n, w) => n + w.capsules.length, 0);
console.log(`templateId: ${APP_ID}`);
console.log(`icons: ${ICONS}`);
console.log(`modes: ${cfg.ui.nav.items[0].config.modes.items.length} / capsules: ${capsuleCount}`);
console.log(`-> dist/${outName}/${APP_ID}/`);
