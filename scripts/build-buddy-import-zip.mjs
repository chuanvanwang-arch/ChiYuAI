/**
 * 一键生成 Buddy 应用「导入配置」ZIP。
 *
 * 背景与策略：
 *  - 平台 schema 骨架已由导出样本确认（templateId / version / ui.nav.items[].config.modes.items / i18n）。
 *  - 但 modes.items 在样本里是空数组，模式与胶囊的**内部字段名无实例可参考**。
 *  - v2（无冗余推断名）能导入成功但渲染为空 → 说明平台校验宽松（未知字段不拒），只是读不到。
 *  - 因此本脚本采用「多位置 + 多别名冗余」：同一份数据用多套候选字段名、写在多个候选位置，
 *    任一命中即可渲染。导入安全性不受影响（已验证平台不因额外字段拒绝）。
 *
 * 用法: node scripts/build-buddy-import-zip.mjs [--app-id=cb_xxx] [--icons=empty|path|inline] [--alias=on|off] [--out=dist/x.zip]
 */
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync,
  readdirSync, statSync,
} from 'node:fs';
import { join, dirname, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};

const ICONS = arg('icons', 'empty'); // empty | path | inline
const ALIAS = arg('alias', 'on') === 'on';
const OTHERS = arg('others', ALIAS ? 'on' : 'off') === 'on';
const OUT = arg('out', join(root, 'dist', 'buddy-crm-import.zip'));

const manifest = JSON.parse(readFileSync(join(root, 'buddy-crm-manifest.json'), 'utf8'));
const APP_ID = arg('app-id', manifest.app.appId);

// 骨架样本：默认取「最新」导出样本（sampleN 数字最大者）。
// ⚠ 铁律：必须用最新样本。旧样本（如 sample2）的 market.json 是空壳（3.9KB），
// 拿它当骨架会在导入时把用户已在 UI 填好的市场配置整体清空（真实事故，2026-09-08）。
const distDir = join(root, 'dist');
const sampleRoots = readdirSync(distDir)
  .filter((d) => /^buddy-export-sample\d*$/.test(d))
  .map((d) => ({ d, n: Number((d.match(/(\d+)$/) || [0, 0])[1]) }))
  .sort((a, b) => b.n - a.n)
  .map((x) => join(distDir, x.d, APP_ID));
const sampleOverride = arg('sample', '');
const sampleDir = (sampleOverride ? [join(root, sampleOverride, APP_ID)] : sampleRoots).find((d) => existsSync(d));
if (!sampleDir) {
  console.error('缺少导出样本目录: dist/buddy-export-sample*');
  process.exit(1);
}
const sampleIndustry = JSON.parse(readFileSync(join(sampleDir, 'industry-config.json'), 'utf8'));
const sampleMarket = JSON.parse(readFileSync(join(sampleDir, 'market.json'), 'utf8'));

const mime = (p) => (p.endsWith('.png') ? 'image/png' : p.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
const dataUri = (rel) => {
  const p = join(root, rel);
  if (!existsSync(p)) return '';
  return `data:${mime(rel)};base64,${readFileSync(p).toString('base64')}`;
};
const iconOf = (rel) => (ICONS === 'inline' ? dataUri(rel) : ICONS === 'path' ? rel : '');

/* ---------- 别名冗余：同一数据多字段名 / 多形态各写一份 ---------- */
const modeAliases = (o) =>
  ALIAS
    ? {
        ...o,
        title: o.name,
        label: o.name,
        isDefault: o.default,
        // 长文本只留 1 个额外别名，避免体积膨胀（短别名几乎不占空间，全保留）
        prompt: o.systemPrompt,
        skillIds: o.skills,
      }
    : o;

const capsuleAliases = (o) =>
  ALIAS
    ? {
        ...o,
        title: o.name,
        label: o.name,
        nameEn: o.en,
        englishName: o.en,
        enName: o.en,
        iconUrl: o.icon,
        expertId: o.expert,
        expertName: o.expert,
        skillIds: o.skills,
        prompt: o.systemPrompt,
        // ⚠ templates 不再在此重写：正确形态 {id,title,prompt} 已在 base 中构造，
        //   此处若再写 {text} 会覆盖掉平台唯一能识别的结构（2026-09-08 第三次样本确认）。
        inspirationIds: o.inspirations,
      }
    : o;

/* ---------- industry-config.json ---------- */
const cfg = structuredClone(sampleIndustry);
cfg.templateId = APP_ID;
if (cfg.id) cfg.id = APP_ID;
cfg.version = sampleIndustry.version ?? 1;

/* ---------- 真实 schema（2026-09-08 由第二次导出样本确认） ----------
 * modes: { defaultSelected: "mode_0", items: [ { modeId, title(i18n key),
 *                                                skills:[{id}], scenes:[] } ] }
 * 三个此前踩空的点：
 *   ① 场景胶囊字段名为 scenes，不是 capsules；
 *   ② skills 是 [{id:"xxx"}] 对象数组，不是字符串数组；
 *   ③ title 是 i18n key，真实文本落在 i18n.source['zh-CN']。
 */
cfg.i18n = cfg.i18n || { source: {} };
cfg.i18n.source = cfg.i18n.source || {};
cfg.i18n.source['zh-CN'] = cfg.i18n.source['zh-CN'] || {};
const i18nZh = cfg.i18n.source['zh-CN'];
i18nZh['home.header.title'] = manifest.home.slogan;
i18nZh['home.title'] = manifest.home.slogan;

const homeItem = cfg.ui.nav.items.find((it) => it.id === 'home') || cfg.ui.nav.items[0];
homeItem.config = homeItem.config || {};

/* ---------- 「其他配置」尽力而为注入 ----------
 * 事实：其他配置页的六个字段（跳过绑定/绑定文案/中英占位符/默认模型/模型池）
 * 在平台导出样本中完全不存在 → 属应用级配置，**不在导入通道的运输范围内**。
 * 故此处按多落点候选写入，平台若识别即生效；不识别不影响导入（已验证额外字段不破坏校验）。
 * 这是导入通道能做到的上限，剩余情况仍需 UI 手填（值见随包 其他配置-手填值.txt）。
 */
if (OTHERS && manifest.others) {
  const o = manifest.others;
  const phZh = o.placeholder?.zh || '';
  const phEn = o.placeholder?.en || '';
  const blocks = {
    skipBind: o.skipBind,
    skipJump: o.skipBind,
    bindText: o.bindText,
    bindDescription: o.bindText,
    placeholder: phZh,
    placeholderEn: phEn,
    inputPlaceholder: phZh,
    defaultModel: o.models?.default,
    modelPool: o.models?.pool,
  };
  // 落点1：顶层多个候选键
  cfg.bindConfig = blocks;
  cfg.appConfig = blocks;
  cfg.settings = blocks;
  // 落点2：首页 nav item 的 config（含 chat/input 子结构）
  Object.assign(homeItem.config, {
    placeholder: phZh,
    placeholderEn: phEn,
    inputPlaceholder: phZh,
    skipBind: o.skipBind,
    bindText: o.bindText,
    chat: { placeholder: phZh, placeholderEn: phEn, inputPlaceholder: phZh },
    input: { placeholder: phZh, placeholderEn: phEn },
  });
  // 落点3：i18n（若平台按 key 取占位符）
  i18nZh['home.input.placeholder'] = phZh;
  i18nZh['home.placeholder'] = phZh;
  i18nZh['common.input.placeholder'] = phZh;
  i18nZh['home.input.placeholderEn'] = phEn;
  // 落点4：模型（与平台 models.custom 并存）
  cfg.models = { ...(cfg.models || {}), default: o.models?.default, pool: o.models?.pool };
}

/**
 * ⚠ 全局唯一 id（2026-09-08 第三次导出样本确认）
 * 平台用 `home.scenes.{scene.id}.title` / `...templates.{tpl.id}.title` 拼 i18n key，
 * 而 scene id 若按「mode 内索引」编号（scene_0~4），三个模式会共用到同一批 key，
 * 后写入覆盖先写入 → 14 个场景只剩 5 个标题。故 id 必须跨 mode 全局唯一。
 */
let globalScene = 0;
const modes = manifest.home.workModes.map((w, wi) => {
  const modeId = `mode_${wi}`;
  const scenes = w.capsules.map((c, ci) => {
    const gi = globalScene++;
    const sceneId = `scene_${gi}`;
    // 提示词模版：平台真实形态为 {id, title, prompt}，值直接写文本
    // （旧版写 {text} 平台不识别，42 条模版的 i18n 一条都没生成）
    const templates = c.prompts.map((t, ti) => ({
      id: `tpl_${gi}_${ti}`,
      title: [...t].length > 24 ? `${t.slice(0, 24)}…` : t,
      prompt: t,
      text: t,
      content: t,
    }));
    const base = {
      sceneId,
      id: sceneId,
      title: c.name,
      name: c.name,
      en: c.en,
      nameEn: c.en,
      englishName: c.en,
      icon: iconOf(c.icon),
      iconUrl: iconOf(c.icon),
      skills: c.skills.map((s) => ({ id: s })),
      systemPrompt: c.systemPrompt,
      instruction: c.systemPrompt,
      scenePrompt: c.systemPrompt,
      templates,
      prompts: c.prompts,
      inspirationIds: c.inspirations,
      inspirations: c.inspirations,
      enabled: true,
      order: (ci + 1) * 10,
    };
    if (c.expert) {
      base.expert = { id: c.expert, name: c.expert };
      base.expertId = c.expert;
    }
    return ALIAS ? { ...base, ...capsuleAliases(base) } : base;
  });

  const base = {
    modeId,
    id: modeId,
    title: w.name,
    name: w.name,
    icon: iconOf(w.icon),
    default: !!w.default,
    systemPrompt: w.systemPrompt,
    skills: w.skills.map((s) => ({ id: s })),
    scenes,
    order: (wi + 1) * 10,
  };
  return ALIAS ? { ...base, ...modeAliases(base), capsules: scenes } : base;
});

const di = manifest.home.workModes.findIndex((w) => w.default);
homeItem.config.modes = {
  defaultSelected: `mode_${di >= 0 ? di : 0}`,
  items: modes,
};

// i18n 文本：按样本规律预置 key，若平台把 title 当 key 查找也能命中
modes.forEach((m, wi) => {
  i18nZh[`home.modes.mode_${wi}.title`] = m.title;
  m.scenes.forEach((s) => {
    const sid = s.id;
    // 平台以 `home.scenes.{sceneId}.title` 为 key 渲染；id 全局唯一才不会互相覆盖
    i18nZh[`home.scenes.${sid}.title`] = s.title;
    i18nZh[`home.modes.mode_${wi}.scenes.${sid}.title`] = s.title;
    for (const t of s.templates) {
      i18nZh[`home.scenes.${sid}.templates.${t.id}.title`] = t.title;
      i18nZh[`home.scenes.${sid}.templates.${t.id}.prompt`] = t.prompt;
    }
  });
});

/* ---------- market.json ----------
 * 铁律：完整保留样本内容（structuredClone），只做最小必要改写。
 * 样本 = 用户在平台 UI 上填好的真实市场配置（精选场景/专家/技能/连接器分类树）。
 * 任何"重建"式写法都会把用户内容清空。
 */
const mkt = structuredClone(sampleMarket);
mkt.templateId = APP_ID;
if (mkt.id) mkt.id = APP_ID;
if (mkt.body?.description) mkt.body.description.zh = manifest.app.description || mkt.body.description.zh;

// 自检：若骨架样本的市场配置是空壳，立即中止——避免再次把用户内容覆盖为空
const countUnits = (n) => {
  if (Array.isArray(n)) return n.reduce((s, x) => s + countUnits(x), 0);
  if (n && typeof n === 'object') {
    return (n.type === 'unit' ? 1 : 0) + (n.children ? countUnits(n.children) : 0);
  }
  return 0;
};
const marketUnits = countUnits(mkt.body);
if (marketUnits === 0) {
  console.error(
    `中止：骨架样本 ${sampleDir} 的 market.json 无任何 unit（空壳）。\n` +
      '      用它作骨架会在导入时清空平台上的市场配置。请改用最新导出样本（--sample=dist/buddy-export-sampleN）。'
  );
  process.exit(1);
}

/* ---------- 其他配置（跳过绑定 / 绑定文案 / 占位符 / 模型池）----------
 * ⚠ 这些字段在平台导出样本中不存在（属应用级配置，不随导出/导入往返）。
 *   此处按候选字段名冗余写入，平台若识别即生效；不识别也不影响导入（已验证额外字段不破坏校验）。
 */
if (OTHERS && manifest.others) {
  // 落点5：others / otherConfig 顶层键（此处不可叫 capabilityDescription，
  //        那是 authConfig 的字段，值为「请登录www.chiyuai.com…」，会被覆盖）
  const o = manifest.others;
  const othersBlock = {
    skipBind: o.skipBind,
    skipJump: o.skipBind,
    bindText: o.bindText,
    bindDescription: o.bindText,
    placeholder: o.placeholder?.zh,
    placeholderEn: o.placeholder?.en,
    inputPlaceholder: o.placeholder?.zh,
    defaultModel: o.models?.default,
    modelPool: o.models?.pool,
  };
  cfg.others = othersBlock;
  cfg.otherConfig = othersBlock;
}

/* ---------- 输出目录 ---------- */
// 复用目录、靠覆盖写保证内容最新。不用 rmSync：沙箱对递归删除走安全删除（genie-trash），
// 在部分环境会 ETIMEDOUT 导致脚本中断。
const staging = join(root, 'dist', 'buddy-import-staging');
const appDir = join(staging, APP_ID);
mkdirSync(appDir, { recursive: true });
writeFileSync(join(appDir, 'industry-config.json'), JSON.stringify(cfg, null, 2), 'utf8');
writeFileSync(join(appDir, 'market.json'), JSON.stringify(mkt, null, 2), 'utf8');

// 「其他配置」手填值（非 JSON 文件：避免平台扫描包内 JSON 时被误判/校验失败）
const othersTxt = [
  '其他配置 — 需在平台页面手动填写（导入通道不运输这些字段）',
  '==========================================================',
  `跳过绑定            : ${manifest.others?.skipBind === false ? '否' : '是'}`,
  `绑定引导文案        : ${manifest.others?.bindText || ''}`,
  `输入框占位符（中文）: ${manifest.others?.placeholder?.zh || ''}`,
  `输入框占位符（英文）: ${manifest.others?.placeholder?.en || ''}`,
  `默认模型            : ${manifest.others?.models?.default || ''}`,
  `模型池              : ${(manifest.others?.models?.pool || []).join(', ')}`,
  '',
  '说明：这 6 项属应用级配置，导出/导入文件中均不存在（已逐字段验证），',
  '      故 zip 导入无法写入。已在 industry-config.json 中按多落点候选写入，',
  '      若平台后续支持即自动生效；当前仍需按上表在页面填写（约 2 分钟）。',
  '',
  '本包已覆盖：基础配置 ✓ / 首页配置 ✓ / 市场配置 ✓',
].join('\n');
writeFileSync(join(appDir, 'OTHERS-CONFIG-MANUAL-FILL.txt'), othersTxt, 'utf8');

// 图标资源（无论 icon 字段是否引用都带上，便于平台按路径取或人工上传）
let iconCount = 0;
for (const w of manifest.home.workModes) {
  for (const rel of [w.icon, ...w.capsules.map((c) => c.icon)]) {
    if (!rel || !existsSync(join(root, rel))) continue;
    const dst = join(staging, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(root, rel), dst);
    iconCount += 1;
  }
}
const avatar = join(root, 'buddy-app-store-listing', 'app-avatar.png');
if (existsSync(avatar)) {
  mkdirSync(join(staging, 'assets'), { recursive: true });
  copyFileSync(avatar, join(staging, 'assets', 'app-avatar.png'));
}
// 日/夜首页背景图（基础配置区上传用）
for (const hero of ['hero-day-1000x910.png', 'hero-night-1000x910.png']) {
  const p = join(root, 'buddy-app-store-listing', hero);
  if (existsSync(p)) {
    mkdirSync(join(staging, 'assets', 'hero'), { recursive: true });
    copyFileSync(p, join(staging, 'assets', 'hero', hero));
  }
}

/* ---------- store zip（零依赖，正斜杠路径，不压缩） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const walk = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
};

const entries = walk(staging).sort();
const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() / 2)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
const chunks = [];
const central = [];
let offset = 0;
for (const file of entries) {
  const nameBuf = Buffer.from(relative(staging, file).split(sep).join('/'), 'utf8');
  const data = readFileSync(file);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, data);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(dosTime, 12);
  cd.writeUInt16LE(dosDate, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);
  offset += local.length + nameBuf.length + data.length;
}
const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([...chunks, cdBuf, eocd]));

const capsuleCount = modes.reduce((n, m) => n + m.scenes.length, 0);
console.log(`appId      : ${APP_ID}`);
console.log(`骨架样本   : ${relative(root, sampleDir) || sampleDir}`);
console.log(`市场配置   : 保留样本内容，unit ${marketUnits} 个（非空壳）`);
console.log(`其他配置   : ${OTHERS ? 'on（冗余写入 skipBind/bindText/placeholder/模型池）' : 'off'}`);
console.log(`modes      : ${modes.length} / capsules: ${capsuleCount}`);
console.log(`icons      : ${ICONS} (资源文件 ${iconCount} 个)`);
console.log(`alias      : ${ALIAS ? 'on（多位置+多别名冗余）' : 'off'}`);
console.log(`zip        : ${OUT} (${entries.length} files, ${statSync(OUT).size} bytes)`);
