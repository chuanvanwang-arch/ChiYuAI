// 脚本标签审计：统计每个 src/web/*.html 的 <script 开标签与 </script> 闭标签数量
// 用途：识别多余闭标签（>开）或缺失闭标签（<开），输出逐文件差异
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src/web');
const files = fs.readdirSync(root).filter(f => f.endsWith('.html')).sort();

const rows = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  // 开标签：<script 后面跟空白、属性或 >；排除 <script src=...>、<script type=...>
  const opens = (text.match(/<script(?=[\s>])/gi) || []).length;
  const closes = (text.match(/<\/script>/gi) || []).length;
  const status = opens === closes ? 'OK ' : opens > closes ? 'MISSING' : 'EXTRA';
  rows.push({ file: f, opens, closes, diff: closes - opens, status });
}

const bad = rows.filter(r => r.diff !== 0);
console.log('文件总数:', rows.length);
console.table(rows);
console.log('\n不匹配文件数:', bad.length);
for (const r of bad) {
  console.log(`${r.status} ${r.file}  open=${r.opens} close=${r.closes} diff=${r.diff}`);
}