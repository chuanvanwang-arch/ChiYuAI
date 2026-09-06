// src/assets/storage.js — 非结构化证据落盘适配层
// 设计：docs/2026-08-31-unstructured-asset-attach-design.md §3.2
// 决策：本地磁盘存字节流 + 粒子 payload 只存元数据（storage:'local' 抽象前缀，
//       未来接对象存储只新增 adapter，不动粒子模型）。
// 幂等：同内容（sha256）重复上传返回同一 rel/path——禁删铁律下用幂等替代去重删除。
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = join(__dirname, '..', '..', 'uploads', 'assets');

function ymd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** rel（相对路径，posix 风格）→ 绝对落盘路径 */
export function pathFor(rel, rootDir = DEFAULT_ROOT) { return join(rootDir, rel); }

/**
 * 落盘并返回元数据。
 * @param {{buf:Buffer, file_name?:string, mime?:string, rootDir?:string}} args
 * @returns {Promise<{path:string, rel:string, sha256:string, size:number, mime:string, file_name:string}>}
 */
export async function storeBuffer({ buf, file_name = 'asset.bin', mime = 'application/octet-stream', rootDir = DEFAULT_ROOT } = {}) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  // 文件名安全过滤：仅保留 word/点/连字符，防路径穿越与脏名
  const safeName = String(file_name || 'asset.bin').replace(/[^\w.\-]+/g, '_');
  const safeExt = extname(safeName) || '.bin';
  const sub = ymd();
  mkdirSync(join(rootDir, sub), { recursive: true });
  const rel = `${sub}/${sha256.slice(0, 16)}${safeExt}`;
  const full = join(rootDir, rel);
  if (!existsSync(full)) writeFileSync(full, data); // 幂等：已存在不重复写
  return { path: full, rel, sha256, size: data.length, mime, file_name: safeName };
}

/** 按 rel 读回字节流（下载端点用） */
export function readStored(rel, rootDir = DEFAULT_ROOT) { return readFileSync(join(rootDir, rel)); }

/** 是否存在（下载前置校验，避免抛异常路径） */
export function existsStored(rel, rootDir = DEFAULT_ROOT) { return existsSync(join(rootDir, rel)); }
