// src/commands/use.js
import { saveCredentials, loadCredentials } from '../credentials.js';
import { resolveEndpoint } from '../endpoints.js';

export async function useEndpoint(args) {
  const id = args[0];
  if (!id) { console.error('用法: crm-cli use <prod|local|www>'); process.exit(2); }
  const ep = resolveEndpoint(id);      // 未知档位直接抛错
  const c = loadCredentials() || {};
  saveCredentials({ ...c, endpoint: id });
  console.log(`当前端点: ${id} → ${ep.url}\n${ep.note}`);
}
