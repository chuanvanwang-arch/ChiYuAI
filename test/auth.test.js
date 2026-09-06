// test/auth.test.js — 登录/me 路由单测
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/http/server.js';
import { query } from '../src/db.js';

let app;
beforeEach(async () => {
  await query('TRUNCATE crm.crm_users RESTART IDENTITY CASCADE');
  await query(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, email)
     VALUES ($1, crypt($2, gen_salt('bf')), 'sales', '销售-示例', $3)`,
    ['alice', 'secret123', 'alice@example.com']
  );
});
beforeEach(() => { app = createApp(); });

const post = (path, body) => app.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/auth/login', () => {
  it('用户名正确密码返回 token+role', async () => {
    const res = await post('/api/auth/login', { username: 'alice', password: 'secret123' });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.token).toMatch(/\./); expect(j.role).toBe('sales');
  });
  it('邮箱正确密码同样返回 token+role', async () => {
    const res = await post('/api/auth/login', { username: 'alice@example.com', password: 'secret123' });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.token).toMatch(/\./); expect(j.role).toBe('sales');
  });
  it('错误密码返回 401', async () => {
    const res = await post('/api/auth/login', { username: 'alice', password: 'wrong' });
    expect(res.status).toBe(401);
  });
  it('未知用户返回 401', async () => {
    const res = await post('/api/auth/login', { username: 'nobody', password: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('有效 token 返回角色', async () => {
    const login = await post('/api/auth/login', { username: 'alice', password: 'secret123' });
    const { token } = await login.json();
    const res = await app.fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json();
    expect(res.status).toBe(200); expect(j.role).toBe('sales');
  });
  it('无 token 返回 401', async () => {
    const res = await app.fetch('/api/auth/me');
    expect(res.status).toBe(401);
  });
  it('篡改 token 返回 401', async () => {
    const res = await app.fetch('/api/auth/me', { headers: { Authorization: 'Bearer a.b.c' } });
    expect(res.status).toBe(401);
  });
});
