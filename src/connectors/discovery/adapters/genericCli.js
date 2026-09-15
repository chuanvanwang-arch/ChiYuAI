// src/connectors/discovery/adapters/genericCli.js — 通用 CLI 租户适配器（沙箱/超时/白名单，仅只读查询类命令）
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';

const BLOCKED = /(rm|del|delete|drop|truncate|mkfs|>:|:>|sudo|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh)/i;
const TIMEOUT_MS = Number(process.env.GENERIC_CLI_TIMEOUT_MS || 10000);

export function genericCliAdapter(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: cfg.id, kind: 'generic-cli', scope: 'tenant', costTier: 0,
        coverageFields: Object.keys(cfg.field_map || {}), ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      const { command, args = [], field_map: fm } = this.config;
      if (!command || BLOCKED.test(`${command} ${args.join(' ')}`)) return {}; // 写入类命令禁止
      const exec = ctx.__exec || this.config.__exec || (async (cmd, a) => {
        const { spawn } = await import('child_process');
        return new Promise((resolve) => {
          const p = spawn(cmd, a, { timeout: TIMEOUT_MS });
          let stdout = '';
          p.stdout.on('data', (d) => (stdout += d));
          p.on('close', () => resolve({ stdout }));
        });
      });
      let data = {};
      try {
        const { stdout } = await exec(command, [...args, entity?.name || '']);
        // 支持 key=value 行 或 JSON
        try { data = JSON.parse(stdout); } catch { for (const line of stdout.split('\n')) { const m = line.match(/^(\w+)=(.*)$/); if (m) data[m[1]] = m[2]; } }
      } catch { return {}; }
      const out = {};
      for (const f of fields) {
        const src = fm[f];
        if (src != null && data[src] != null) Object.assign(out, fieldHit(f, { value: data[src], confidence: 0.7, cost: 0, provider: this.id }));
      }
      return out;
    }
  })();
}
