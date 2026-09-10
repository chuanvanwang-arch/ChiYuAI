/**
 * 从 buddy-crm-manifest.json（单一事实源）渲染《Buddy 应用配置填写手册》。
 * 输出：docs/2026-09-08-buddy-app-config-checklist.md
 * 用法：node scripts/gen-config-checklist.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const m = JSON.parse(readFileSync(join(root, 'buddy-crm-manifest.json'), 'utf8'));

const L = [];
const push = (s = '') => L.push(s);

push('# Buddy 应用配置填写手册');
push();
push(`> 应用 ID：\`${m.app.appId}\`　|　生成自 \`buddy-crm-manifest.json\`（单一事实源，改动后重跑 \`node scripts/gen-config-checklist.mjs\`）`);
push('> 用法：按章节在开放平台页面逐项填写；或改用「导入配置」通道上传生成好的文件包。');
push();

// ---------- 1 应用信息 ----------
push('## 1. 应用信息');
push();
push('| 字段 | 填写值 |');
push('|---|---|');
push(`| 应用 ID | \`${m.app.appId}\`（平台生成，不可改） |`);
push(`| 应用名称 | ${m.app.name} |`);
push(`| 应用简介 | ${m.app.intro} |`);
push(`| 应用头像 | \`buddy-app-store-listing/app-avatar.png\`（512×512 PNG，5.4 KB） |`);
push(`| 授权 URL / 回调 | ${m.app.oauth.callback || '（待定，见 §5 待确认项）'} |`);
push();

// ---------- 2 首页配置 ----------
push('## 2. 首页配置');
push();
push(`**首页标题**（≤25 字）：\`${m.home.slogan}\``);
push();
push(`**内置连接器**：${m.home.connectors.map((c) => `\`${c}\``).join('、')}`);
push();

for (const w of m.home.workModes) {
  push(`### 工作模式：${w.name}${w.default ? '（设为默认）' : ''}`);
  push();
  push(`- **模式名称**：${w.name}（${[...w.name].length}/4 字）`);
  push(`- **图标**：\`${w.icon}\``);
  push(`- **关联技能**：${w.skills.map((s) => `\`${s}\``).join('、')}`);
  push(`- **关联胶囊**：${w.capsules.map((c) => c.name).join('、')}`);
  push();
  push('<details><summary>系统提示词（展开复制）</summary>');
  push();
  push('```text');
  push(w.systemPrompt);
  push('```');
  push();
  push('</details>');
  push();

  for (const c of w.capsules) {
    push(`#### 胶囊：${c.name}（${c.en}）`);
    push();
    push('| 字段 | 值 |');
    push('|---|---|');
    push(`| 胶囊名称 | ${c.name}（${[...c.name].length}/8） |`);
    push(`| 英文名称 | ${c.en}（${[...c.en].length}/30） |`);
    push(`| 图标 | \`${c.icon}\` |`);
    push(`| 绑定专家 | ${c.expert} |`);
    push(`| 绑定技能 | ${c.skills.map((s) => `\`${s}\``).join('、')} |`);
    push(`| 关联灵感 | ${c.inspirations.join('、')} |`);
    push();
    push('**系统提示词**（点击胶囊后注入模型，用户不可见）：');
    push();
    push('```text');
    push(c.systemPrompt);
    push('```');
    push();
    push(`**提示词模版**（${c.prompts.length} 个，范围 2–10）：`);
    push();
    c.prompts.forEach((p, i) => push(`${i + 1}. ${p}`));
    push();
  }
}

// ---------- 3 市场配置 ----------
push('## 3. 市场配置');
push();
push(`- **专家**：${m.market.experts.join('、')}`);
push(`- **连接器**：${m.market.connectors.join('、')}`);
push(`- **案例**：${m.market.cases.join('、')}`);
push();
const skills = readdirSync(join(root, 'connector', 'skills')).sort();
push(`> **技能**（以「已上架」目录 \`connector/skills/\` 为准，共 ${skills.length} 个）：`);
push('>');
skills.forEach((s) => push(`> - \`${s}\``));
push();

// ---------- 4 其他配置 ----------
push('## 4. 其他配置');
push();
push('| 字段 | 值 |');
push('|---|---|');
push(`| 跳过绑定 | ${m.others.skipBind ? '是' : '否'} |`);
push(`| 绑定引导文案 | ${m.others.bindText} |`);
push(`| 输入框占位符（中） | ${m.others.placeholder.zh} |`);
push(`| 输入框占位符（英） | ${m.others.placeholder.en} |`);
push(`| 默认模型 | ${m.others.models.default} |`);
push(`| 模型池 | ${m.others.models.pool.join('、')} |`);
push();

// ---------- 5 待确认 ----------
push('## 5. 待确认项');
push();
push('1. **授权 URL / 回调地址**：`chiyuai.com` 存在 SNI 级拦截（未备案），生产不可用；`src/` 尚无 oauth 回调路由。');
push('2. **关联灵感**：手册中的灵感名需与灵感库实际条目对齐后勾选。');
push('3. **平台管理类胶囊**（权限管理/计费套餐/技能开关）暂无专属上架技能，深度操作需引导至平台管理页。');
push();

const out = join(root, 'docs', '2026-09-08-buddy-app-config-checklist.md');
writeFileSync(out, L.join('\n'), 'utf8');
console.log(`written: ${out} (${L.length} lines)`);
