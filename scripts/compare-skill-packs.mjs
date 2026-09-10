/**
 * 对比 CRM 自有技能包 与 北森 beisen-cli / 腾讯电子签 tencent-esign-contract 的规格差异。
 * 只读，不改任何文件。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = 'C:/Users/wangchuan08/.workbuddy';
const CRM = 'D:/system/CRM-ai-native';

const frontmatter = (p) => {
  const t = readFileSync(p, 'utf8');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return { raw: m ? m[1] : '', body: t };
};
const field = (fm, key) => {
  const m = fm.raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
};

const rows = [];
for (const dir of readdirSync(join(CRM, 'connector/skills'))) {
  const p = join(CRM, 'connector/skills', dir, 'SKILL.md');
  if (!existsSync(p)) continue;
  const fm = frontmatter(p);
  rows.push({
    src: 'CRM',
    name: dir,
    desc: [...(field(fm, 'description') || '')].length,
    body: [...fm.body].length,
    keys: fm.raw.split('\n').filter((l) => /^[a-z_-]+:/.test(l)).map((l) => l.split(':')[0]),
  });
}

const bench = [
  ['北森·员工档案', `${HOME}/connectors-marketplace/connectors/beisen-cli/skills/beisen-employee-profile/SKILL.md`],
  ['北森·共享基座', `${HOME}/connectors-marketplace/connectors/beisen-cli/skills/beisen-shared/SKILL.md`],
  ['北森·数据查询', `${HOME}/connectors-marketplace/connectors/beisen-cli/skills/beisen-data-query/SKILL.md`],
  ['腾讯电子签', `${HOME}/skills-marketplace/skills/tencent-esign-contract/SKILL.md`],
];
const benchRows = [];
for (const [label, p] of bench) {
  if (!existsSync(p)) { benchRows.push({ src: 'BENCH', name: label, desc: 0, body: 0, keys: [], missing: true }); continue; }
  const fm = frontmatter(p);
  benchRows.push({
    src: 'BENCH', name: label,
    desc: [...(field(fm, 'description') || '')].length,
    body: [...fm.body].length,
    keys: fm.raw.split('\n').filter((l) => /^[a-z_-]+:/.test(l)).map((l) => l.split(':')[0]),
  });
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length));
console.log('=== 描述字段长度 & 正文规模对比 ===');
console.log(pad('来源', 6) + pad('技能', 28) + pad('描述字数', 10) + pad('正文总字数', 12) + 'frontmatter 字段');
for (const r of [...benchRows, ...rows]) {
  console.log(pad(r.src, 6) + pad(r.name, 28) + pad(r.desc, 10) + pad(r.body, 12) + (r.keys || []).join(','));
}

const avg = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
const crmDesc = rows.map((r) => r.desc);
const benchDesc = benchRows.filter((r) => r.name.startsWith('北森·员工') || r.name.startsWith('腾讯')).map((r) => r.desc);
console.log('\n=== 汇总 ===');
console.log('CRM 技能数:', rows.length, '| 描述字数 平均', avg(crmDesc), '最短', Math.min(...crmDesc), '最长', Math.max(...crmDesc));
console.log('对照样本描述字数:', benchDesc.join(' / '), '| 平均', avg(benchDesc));

const allKeys = new Set();
rows.forEach((r) => r.keys.forEach((k) => allKeys.add(k)));
console.log('CRM frontmatter 使用的字段:', [...allKeys].sort().join(','));
console.log('北森/腾讯使用的字段:', [...new Set(benchRows.flatMap((r) => r.keys))].sort().join(','));

const dirSize = (p) => {
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const f of readdirSync(p)) {
    const fp = join(p, f);
    n += statSync(fp).isDirectory() ? dirSize(fp) : statSync(fp).size;
  }
  return n;
};
console.log('\n=== 包体积 ===');
console.log('CRM connector/skills 总字节:', dirSize(join(CRM, 'connector/skills')));
console.log('北森 beisen-cli 总字节:', dirSize(`${HOME}/connectors-marketplace/connectors/beisen-cli`));
console.log('腾讯电子签 总字节:', dirSize(`${HOME}/skills-marketplace/skills/tencent-esign-contract`));
