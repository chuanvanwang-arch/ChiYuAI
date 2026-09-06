// test/assets/upload.test.js — 非结构化证据上传/下载端点
// 设计：docs/2026-08-31-unstructured-asset-attach-design.md §4.1
// 语义：上传 = staging（不碰业务数据，免 confirm）；挂接才过闸（见 attach.test.js）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

const app = createApp();
const token = issueToken({ username: 'tester', role: 'admin', display_name: '测试员' });
const AUTH = { Authorization: `Bearer ${token}` };

// 上传体：octet-stream 字节 + 元数据走 header（零 multipart 依赖）
function uploadBody(buf, extraHeaders = {}) {
  return {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'test-doc.txt', 'X-File-Mime': 'text/plain', ...extraHeaders },
    body: buf,
  };
}

const created = [];
async function upload(buf, extra = {}) {
  const res = await app.fetch('/api/assets/upload', uploadBody(buf, extra));
  const json = await res.json().catch(() => ({}));
  if (json?.asset_id) created.push(json.asset_id);
  return { res, json };
}

describe('T3 POST /api/assets/upload', () => {
  afterAll(async () => {
    if (created.length) await queryWrite(`DELETE FROM crm.particles WHERE id = ANY($1::uuid[])`, [created]);
  });

  it('无 token → 401（鉴权双源均未通过）', async () => {
    const res = await app.fetch('/api/assets/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.txt' },
      body: Buffer.from('x'),
    });
    expect(res.status).toBe(401);
  });

  it('带 token 上传 → 200 + asset_id，粒子 payload 元数据齐全', async () => {
    const { res, json } = await upload(Buffer.from('hello doc'));
    expect(res.status).toBe(200);
    expect(json.asset_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.file_name).toBe('test-doc.txt');
    expect(json.size).toBe(9);
    const p = await queryWrite(`SELECT type, state, payload FROM crm.particles WHERE id=$1`, [json.asset_id]);
    expect(p.rows[0].type).toBe('CRM_UNSTRUCTURED_ASSET');
    expect(p.rows[0].state).toBe('uploaded');
    expect(p.rows[0].payload.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p.rows[0].payload.storage).toBe('local');
    expect(p.rows[0].payload.file_name).toBe('test-doc.txt');
    expect(p.rows[0].payload.mime).toBe('text/plain');
    expect(p.rows[0].payload.rel_path).toBeTruthy(); // 下载端点按此回吐
  });

  it('同内容二次上传幂等 → 返回同一 asset_id（禁删语义下用幂等替代去重删除）', async () => {
    const a = await upload(Buffer.from('dup-content'));
    const b = await upload(Buffer.from('dup-content'));
    expect(a.json.asset_id).toBeTruthy();
    expect(b.json.asset_id).toBe(a.json.asset_id);
    expect(b.json.deduped).toBe(true);
  });

  it('缺 X-File-Name → 400（identity 字段不可空）', async () => {
    const res = await app.fetch('/api/assets/upload', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x'),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/assets/:id/download 回吐字节一致 + attachment 头', async () => {
    const up = await upload(Buffer.from('download-me'));
    const res = await app.fetch(`/api/assets/${up.json.asset_id}/download`, { headers: AUTH });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('download-me');
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('下载不存在的资产 → 404', async () => {
    const res = await app.fetch('/api/assets/00000000-0000-0000-0000-000000000000/download', { headers: AUTH });
    expect(res.status).toBe(404);
  });
});
