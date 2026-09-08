// src/credentials.js — 凭据仅落本地，绝不进仓库/日志/聊天
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.CRM_CLI_HOME || homedir();
export const CRED_PATH = join(HOME, '.crm-cli', 'credentials');

export function saveCredentials(obj) {
  mkdirSync(dirname(CRED_PATH), { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(CRED_PATH, 0o600); } catch { /* Windows 无 POSIX 权限，尽力而为 */ }
  return CRED_PATH;
}

export function loadCredentials() {
  if (!existsSync(CRED_PATH)) return null;
  try { return JSON.parse(readFileSync(CRED_PATH, 'utf8')); } catch { return null; }
}

export function clearCredentials() {
  if (existsSync(CRED_PATH)) rmSync(CRED_PATH, { force: true });
}
