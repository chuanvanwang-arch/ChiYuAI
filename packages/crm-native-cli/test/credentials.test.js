import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 用临时 HOME 隔离，绝不污染真实 ~/.crm-cli
const tmp = mkdtempSync(join(tmpdir(), 'crmcli-'));
process.env.CRM_CLI_HOME = tmp;

const { CRED_PATH, saveCredentials, loadCredentials, clearCredentials } = await import('../src/credentials.js');

describe('凭据存储', () => {
  afterEach(() => { if (existsSync(CRED_PATH)) rmSync(CRED_PATH, { force: true }); });

  it('保存后可读回，且文件权限为 0600（Windows 下尽力而为）', () => {
    saveCredentials({ endpoint: 'prod', user: 'admin', pass: 'x', apiToken: 't', expiresAt: Date.now() + 1000 });
    const c = loadCredentials();
    expect(c.user).toBe('admin');
    expect(c.apiToken).toBe('t');
    if (process.platform !== 'win32') {
      expect(statSync(CRED_PATH).mode & 0o777).toBe(0o600);
    }
  });

  it('未登录时返回 null，不抛错', () => {
    if (existsSync(CRED_PATH)) rmSync(CRED_PATH, { force: true });
    expect(loadCredentials()).toBeNull();
  });

  it('序列化内容不含多余字段（不落聊天、不落口令明文以外的东西）', () => {
    saveCredentials({ endpoint: 'prod', user: 'admin', pass: 'x' });
    const raw = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
    expect(Object.keys(raw).sort()).toEqual(['endpoint', 'pass', 'user']);
  });

  it('clearCredentials 后文件消失且 load 返回 null', () => {
    saveCredentials({ endpoint: 'local', user: 'u', pass: 'p' });
    clearCredentials();
    expect(existsSync(CRED_PATH)).toBe(false);
    expect(loadCredentials()).toBeNull();
  });
});
