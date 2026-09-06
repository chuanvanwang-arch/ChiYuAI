// CRM Buddy 应用 · 三层验证回归套件
// 依次运行：
//   1. buddy-capsule-binding-check.mjs  静态契约：routeThroughIntake 确定性保留 + 工具名在 MCP 暴露集
//   2. buddy-e2e-probe.mjs             运行态 MCP 真机派发探针（crm_login + callTool）
//   3. buddy-dispatch-e2e.mjs          HTTP dispatch → DB 透传真机闭环
// 依赖：App(3000) + PG(5433) + MCP(3001) 在线；先 `npm run mcp` 起 MCP 服务。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUITE = [
  {
    key: 'static-binding',
    file: 'buddy-capsule-binding-check.mjs',
    desc: '胶囊→method-* 静态契约校验（routeThroughIntake + MCP 工具集）',
  },
  {
    key: 'mcp-probe',
    file: 'buddy-e2e-probe.mjs',
    desc: '运行态 MCP 真机派发探针（crm_login + callTool）',
  },
  {
    key: 'dispatch-e2e',
    file: 'buddy-dispatch-e2e.mjs',
    desc: 'HTTP dispatch → DB 透传真机闭环',
  },
];

function run(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath], { stdio: 'inherit', env: process.env });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   CRM Buddy 应用 · 三层验证回归套件                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  const results = [];
  for (const s of SUITE) {
    console.log(`\n────────── [${s.key}] ${s.desc} ──────────`);
    const code = await run(join(__dirname, s.file));
    results.push({ key: s.key, desc: s.desc, code });
  }
  console.log('\n════════════════════════ 汇总 ══════════════════════');
  let failed = 0;
  for (const r of results) {
    const ok = r.code === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.key.padEnd(16)} exit=${r.code}  ${r.desc}`);
  }
  console.log(`\n总计: ${results.length - failed}/${results.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
