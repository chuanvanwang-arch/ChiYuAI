// scripts/validate-contract.mjs — CLI 包装；解析内核已迁至 src/contract/contractParser.js（单一事实源）
export * from '../src/contract/contractParser.js';
import {
  extractContractBlocks, parseContractYaml, validateContracts, loadRegistry,
} from '../src/contract/contractParser.js';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

async function main() {
  const args = process.argv.slice(2);
  const docPath = args.find((a) => !a.startsWith('--'));
  const regIdx = args.indexOf('--registry');
  const registry = regIdx !== -1 ? await loadRegistry(args[regIdx + 1]) : null;
  if (!docPath) {
    console.error('usage: node validate-contract.mjs <doc.md> [--registry path]');
    process.exit(2);
  }
  const md = readFileSync(docPath, 'utf8');
  const contracts = extractContractBlocks(md).flatMap((b) => parseContractYaml(b));
  const result = validateContracts(contracts, { registry });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

// 仅在 CLI 直接运行时执行（被 import 时不触发）。跨平台大小写归一。
const __invoked = process.argv[1]
  ? fileURLToPath(pathToFileURL(process.argv[1]).href)
  : null;
const __self = fileURLToPath(import.meta.url);
if (__invoked && __invoked.toLowerCase() === __self.toLowerCase()) {
  main();
}
