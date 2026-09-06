// test/assets/storage.test.js — 非结构化证据落盘适配层
// 设计：docs/2026-08-31-unstructured-asset-attach-design.md §3.2（storage:'local' 抽象）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeBuffer, readStored, pathFor } from '../../src/assets/storage.js';

let dir;
beforeAll(() => {
  dir = join(tmpdir(), 'crm-asset-test-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('T2 asset storage', () => {
  it('store 落盘并返回元数据（path/rel/sha256/size/mime）', async () => {
    const buf = Buffer.from('hello asset');
    const r = await storeBuffer({ buf, file_name: 'a.txt', mime: 'text/plain', rootDir: dir });
    expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.size).toBe(11);
    expect(r.mime).toBe('text/plain');
    expect(r.rel).toMatch(/^\d{4}-\d{2}[\\/]/); // 按 yyyy-mm 分目录
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path).toString()).toBe('hello asset');
    expect(readStored(r.rel, dir).toString()).toBe('hello asset');
    expect(pathFor(r.rel, dir)).toBe(r.path);
  });

  it('同内容二次上传幂等：同 sha256 → 同 path（禁删语义下用幂等替代去重删除）', async () => {
    const buf = Buffer.from('dup');
    const a = await storeBuffer({ buf, file_name: 'x.txt', mime: 'text/plain', rootDir: dir });
    const b = await storeBuffer({ buf, file_name: 'x2.txt', mime: 'text/plain', rootDir: dir });
    expect(b.sha256).toBe(a.sha256);
    expect(b.path).toBe(a.path);
  });
});
