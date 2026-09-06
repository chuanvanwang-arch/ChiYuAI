// test/propagation/no-delete.test.js
// 合规专项（fail-closed）：传播相关模块源码不得出现物理删除（DELETE FROM）
// 依据：测试计划 §5 合规专项 2。迁移文件（db/*.js）允许 ADD COLUMN/CREATE TABLE，故排除。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../');

const targets = [
  'src/config/broadcast.js',
  'src/memory/promote.js',
  'src/http/propagationRoutes.js',
  'src/decision/prescription.js',
  'src/decision/retro.js',
];

describe('传播模块禁 DELETE 扫描', () => {
  for (const rel of targets) {
    it(`${rel} 不含 DELETE FROM`, () => {
      const p = resolve(root, rel);
      expect(existsSync(p)).toBe(true);
      const src = readFileSync(p, 'utf8');
      // 排除注释与字符串字面量中的误报：仅扫描独立 SQL 关键字
      const matched = src.match(/DELETE\s+FROM/gi);
      expect(matched, `${rel} 出现 DELETE FROM：${matched}`).toBeNull();
    });
  }
});
