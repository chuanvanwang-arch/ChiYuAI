// test/config/industryTemplateDiscovery.test.js
// §12.3 行业模板 discovery 段：形状有效性 + 付费源铁律 + 键分离（纯单测，零 PG）
//
// ⚠ 核心风险点：mergeDiscoveryRules（src/config/discoveryRules.js:47-60）**只认**以下形状，
//   写错一律**静默丢弃**（无异常、无日志 ⇒ 假绿）：
//     icp        浅合并 → 键名必须 ∈ {industries, min_headcount, geo, min_confidence}
//     signals    浅合并 → 每项必须是 { weight: <number> }（写数字会把对象整个换掉）
//     providers  Array.isArray() 为真才处理，且仅**覆盖既有 id**（不增删条数，防租户越权新增付费源）
//     playbooks  Array.isArray() 为真才处理 → 每项必须是有 name 的对象（compilePlaybook 无名即 throw）
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { mergeDiscoveryRules, DEFAULT_DISCOVERY_RULES } from '../../src/config/discoveryRules.js';
import { DISCOVERY_RULES_BY_INDUSTRY } from '../../db/seed/discovery-rules-templates.js';

// ⚠ 显式白名单（与 db/seed/tenant-profile-templates.mjs 的 SPECS 同源 7 项）
//    **不得**用 readdirSync 全量 glob —— db/seed 下另有未跟踪的 tenant-profile-manufacturing.js（另一功能线）
const TEMPLATES = ['chemical', 'consult', 'consult2', 'demo', 'insmedi', 'meddev', 'training'];
const seedPath = (f) => `db/seed/tenant-profile-${f}.js`;

describe('行业模板 discovery 段（§12.3）', () => {
  it('① 白名单 7 项与实际文件一一对应（防"新模板漏配"）', () => {
    expect(TEMPLATES.length).toBe(7);
    for (const f of TEMPLATES) expect(existsSync(seedPath(f)), f).toBe(true);
    expect(Object.keys(DISCOVERY_RULES_BY_INDUSTRY).sort()).toEqual([...TEMPLATES].sort());
  });

  it('② 每份模板的 discovery 配置经真实 mergeDiscoveryRules 后形状有效（防静默丢弃）', () => {
    // 唯一的合法 icp 键名（臆造键会被 Object.assign 静默写入却不被任何消费方读取）
    const ICP_KEYS = new Set(['industries', 'min_headcount', 'geo', 'min_confidence']);
    for (const f of TEMPLATES) {
      const cfg = DISCOVERY_RULES_BY_INDUSTRY[f];
      expect(cfg, f).toBeTruthy();

      // —— 输入形状必须自身合法 ——
      // ⚠ 只断言"合并结果仍是数组"是**假绿**：坏输入被 mergeDiscoveryRules 静默丢弃后，
      //   结果会回退到出厂默认（本身就是数组）⇒ 断言通过而配置完全没生效。必须断言**输入**。
      expect(Array.isArray(cfg.providers), `${f}.providers 必须是数组`).toBe(true);
      expect(Array.isArray(cfg.playbooks), `${f}.playbooks 必须是数组`).toBe(true);
      for (const [k, v] of Object.entries(cfg.signals || {})) {
        expect(typeof v?.weight, `${f}.signals.${k} 必须是 { weight: number }`).toBe('number');
      }
      for (const pb of cfg.playbooks) expect(typeof pb?.name, `${f}.playbooks[] 必须含 name`).toBe('string');
      for (const k of Object.keys(cfg.icp || {})) {
        expect(ICP_KEYS.has(k), `${f}.icp.${k} 非 schema 字段（臆造键）`).toBe(true);
      }

      // —— 声明的覆盖必须**真实生效**（写了 == 生效，而非静默丢弃）——
      const merged = mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, cfg);
      expect(merged.providers.length, f).toBe(DEFAULT_DISCOVERY_RULES.providers.length);
      for (const decl of cfg.providers) {
        const hit = merged.providers.find((p) => p.id === decl.id);
        expect(hit, `${f}.providers.${decl.id} 不在出厂清单`).toBeTruthy();
        expect(hit.enabled, `${f}.providers.${decl.id} 覆盖未生效`).toBe(decl.enabled);
      }
      for (const [name, v] of Object.entries(merged.signals)) {
        expect(typeof v?.weight, `${f}.signals.${name} 合并后被破坏`).toBe('number');
      }
      for (const pb of merged.playbooks) expect(typeof pb?.name, f).toBe('string');
    }
  });

  it('③ 出厂默认不被污染（纯函数无副作用）', () => {
    expect(JSON.stringify(DEFAULT_DISCOVERY_RULES.playbooks)).toBe('[]');
    expect(DEFAULT_DISCOVERY_RULES.icp.min_headcount).toBe(50);
  });

  it('④ 付费源铁律（D1）：模板不得声明付费源，且合并后付费源恒 enabled:false', () => {
    for (const f of TEMPLATES) {
      const src = readFileSync(seedPath(f), 'utf8');
      // 声明期即禁：模板里连付费源的名字都不该出现（比"enabled 不为 true"更强）
      expect(src, f).not.toMatch(/clearbit|linkedin/i);
      const merged = mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, DISCOVERY_RULES_BY_INDUSTRY[f]);
      for (const p of merged.providers.filter((x) => x.scope === 'paid')) {
        expect(p.enabled, `${f}.${p.id}`).toBe(false);
      }
    }
  });

  it('⑤ discovery 段独立落 discovery-rules 键，不并入 tenant-profile', () => {
    for (const f of TEMPLATES) {
      const src = readFileSync(seedPath(f), 'utf8');
      expect(src, f).toMatch(/writeConfig\(\s*'discovery-rules'/);
      // tenant-profile 的写入块内不得出现 discovery 字段（保 mergeProfile 零回归）
      const from = src.indexOf("writeConfig('tenant-profile'");
      expect(from, f).toBeGreaterThan(-1);
      const block = src.slice(from, src.indexOf('}, { tenantId });', from));
      expect(block, f).not.toMatch(/^\s*discovery\s*:/m);
    }
  });
});
