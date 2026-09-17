// test/ui/signalCalendarCapsule.test.js — 信号能力分发面契约（Plan A 日历规则 / Plan B 内部异动派生）
// 覆盖：manifest 胶囊形状（prompts/inspirations 非空）· 图标文件真实存在 ·
//       「今日跟进」入口引用信号工具 · skills 值域不变量（⊆ connector/skills）·
//       守卫登记 parity（REQUIRED_TOOL_REFS）· 手维护预览页（index.html / form-cards.html）结构同步
//
// 背景（本轮实测的「落树≠可感知」缺口）：后端 crm.signal 已有产出、web 信号中心已渲染，
// 但**开放平台 BUDDY 应用**侧 3 模式 16 胶囊零引用信号能力 ⇒ 用户在 App 里根本看不到入口。
// 故本测试是「能力必须落到分发面」的守门；缺任一项即视为回归。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('buddy-crm-manifest.json', 'utf8'));
const check = readFileSync('scripts/buddy-capsule-binding-check.mjs', 'utf8');
const preview = readFileSync('assets/capsules/index.html', 'utf8');
const UPLOADED = new Set(readdirSync('connector/skills'));   // 已上架技能 = 场景「绑定技能」合法值域
const CAPS = manifest.home.workModes.flatMap((m) => m.capsules || []);
const TARGET = '提醒日历';
const DAILY = '今日跟进';

describe('buddy 信号能力胶囊（提醒日历 + 今日跟进）', () => {
  it('① manifest 有「提醒日历」胶囊且形状完整（prompts/inspirations 非空）', () => {
    const cap = CAPS.find((c) => c.name === TARGET);
    expect(cap, TARGET).toBeTruthy();
    expect(cap.en).toBe('Reminder Calendar');
    expect(cap.expert).toBe('企业AI销售决策专家');
    expect(Array.isArray(cap.prompts) && cap.prompts.length > 0).toBe(true);
    expect(Array.isArray(cap.inspirations) && cap.inspirations.length > 0).toBe(true);
    expect(cap.systemPrompt).toContain('crm-signal-ics');   // MCP 工具名落在 prompt，不落 skills
    expect(cap.systemPrompt).toContain('crm-signal-list');
  });

  it('② 图标文件真实存在（pack-buddy-import 的 MISSING ICONS 硬闸）', () => {
    const cap = CAPS.find((c) => c.name === TARGET);
    expect(cap.icon).toBe('assets/capsules/signal-calendar.svg');
    expect(existsSync(cap.icon), cap.icon).toBe(true);
  });

  it('③ 「今日跟进」入口已引用 crm-signal-list（信号必须进日常入口，不能只躺在专页）', () => {
    const cap = CAPS.find((c) => c.name === DAILY);
    expect(cap, DAILY).toBeTruthy();
    expect(cap.systemPrompt).toContain('crm-signal-list');
  });

  it('④ 低置信纪律已写进胶囊（内部推断不得与实测情报同权）', () => {
    for (const name of [TARGET, DAILY]) {
      const cap = CAPS.find((c) => c.name === name);
      expect(cap.systemPrompt, name).toContain('内部推断（低置信）');
    }
    // 「不造幽灵日程」= ICS 无日期即失败，禁止推测排期
    const cal = CAPS.find((c) => c.name === TARGET);
    expect(cal.systemPrompt).toContain('不造幽灵日程');
  });

  it('⑤ 全 manifest 场景/模式 skills ⊆ 已上架技能（值域不变量）', () => {
    const viol = [];
    for (const w of manifest.home.workModes) {
      for (const s of w.skills || []) if (!UPLOADED.has(s)) viol.push(`${w.name}:${s}`);
      for (const c of w.capsules || []) {
        for (const s of c.skills || []) if (!UPLOADED.has(s)) viol.push(`${c.name}:${s}`);
      }
    }
    expect(viol).toEqual([]);
  });

  it('⑥ 守卫登记 parity（防「加了胶囊却没进 REQUIRED_TOOL_REFS」静默分叉）', () => {
    expect(check).toContain("capsule: '今日跟进'");
    expect(check).toContain("token: 'crm-signal-list'");
    expect(check).toContain("capsule: '提醒日历'");
    expect(check).toContain("token: 'crm-signal-ics'");
  });

  it('⑦ 手维护预览页 assets/capsules/index.html 未陈旧（计数 + 图标节点 = 实际胶囊数）', () => {
    const total = manifest.home.workModes.reduce((n, w) => n + (w.capsules || []).length, 0);
    const m = preview.match(/(\d+)\s*个场景胶囊/);
    expect(m, '预览页缺少「N 个场景胶囊」声明').toBeTruthy();
    expect(Number(m[1])).toBe(total);
    expect(preview).toContain('signal-calendar.svg');
    // 结构证据：每张卡必须恰好挂 1 个图标节点（只验「图标名在文中出现过」太弱——
    // 同一图标有 3 处引用时删 1 处照样过，2026-09-17 实测）
    expect((preview.match(/src="\.\/[a-z0-9-]+\.svg"/g) || []).length).toBe(total);
  });

  it('⑧ form-cards.html 与清单结构一致（卡片数 / 图标节点数 = 实际胶囊数）', () => {
    const cards = readFileSync('assets/capsules/form-cards.html', 'utf8');
    const total = manifest.home.workModes.reduce((n, w) => n + (w.capsules || []).length, 0);
    // ⚠ 该文件由 gen-capsule-form-cards.mjs 生成后经**外部编辑器追加 `data-page-node-id`**，
    //   直接重生成会抹掉后处理（实测 945/700 行差异）⇒ 只能手工增量维护。
    //   故此处断言的是「结构同步」而非「可重生成」：
    //   2026-09-17 实测它曾写「14 个胶囊」而清单已 17，且实际缺 3 张卡（线索发现/主动拓客/提醒日历）。
    expect((cards.match(/id="cap-[a-z0-9-]+"/g) || []).length).toBe(total);
    expect((cards.match(/class="ico" src="\.\/[a-z0-9-]+\.svg"/g) || []).length).toBe(total);
    expect(cards).toContain('signal-calendar.svg');
    expect(cards).toContain('discovery.svg');
    expect(cards).toContain('prospecting.svg');
  });
});
