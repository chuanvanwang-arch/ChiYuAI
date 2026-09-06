#!/usr/bin/env node
// scripts/issue-mcp-token.js — 本地颁发 MCP token（明文仅打印到本终端，不入库明文）
// 用法: node scripts/issue-mcp-token.js <actor> <roleTag> [scopesJson]
// 例:   node scripts/issue-mcp-token.js wangchuan exec '{"deny_domains":["CRM_CUSTOMER"]}'
import { issueToken } from '../src/mcp/issueToken.js';

const [actor, roleTag, scopesArg] = process.argv.slice(2);
if (!actor || !roleTag) {
  console.error('用法: node scripts/issue-mcp-token.js <actor> <roleTag> [scopesJson]');
  process.exit(1);
}
const scopes = scopesArg ? JSON.parse(scopesArg) : {};
const { tokenPlain, alreadyExists } = await issueToken({ actor, roleTag, scopes });
if (alreadyExists) {
  console.log(`\n⚠️ ${actor} 的 ${roleTag} token 已颁发过。明文仅首次颁发显示一次（哈希不可逆，无法回读）。\n`);
  console.log('如需新 token，请先吊销现有 identity（UPDATE crm.mcp_identity SET revoked_at=now()）再重新颁发。\n');
  process.exit(0);
}
console.log(`\n已为 ${actor} 颁发角色 ${roleTag} 的 MCP token（请妥善保存，仅显示一次）：\n`);
console.log(`  ${tokenPlain}\n`);
console.log('将其作为 Bearer token 或 api_token 参数传入 MCP 调用即可。\n');