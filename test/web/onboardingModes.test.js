// test/web/onboardingModes.test.js — P2 向导三卡（接入路径）的页面契约
// 设计：docs/2026-09-18-unified-integration-design-v2.md §5.3 / §5.4
// 核心判据（用户原话）：「不是做一个本站网页去连接，而是引导用户打开相关应用或工具，由用户输入用户和密码」
//   ⇒ A/B 两条路**本页不收集凭据**；C 路径必须显式声明凭据去向。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SOURCE_KINDS, PREFERRED_SOURCE_KIND } from '../../src/channels/sourceKinds.js';

const guide = readFileSync(new URL('../../src/web/onboarding-guide.html', import.meta.url), 'utf8');
const cfg = readFileSync(new URL('../../src/web/channel-config.html', import.meta.url), 'utf8');

describe('向导三卡：路径即「凭据保存在谁那里」', () => {
  it('三张卡齐备，且与 sourceKinds 事实源同集合（不各自硬编码形态名）', () => {
    for (const k of SOURCE_KINDS) expect(guide).toContain(`id="m-${k}"`);
    expect(guide).toContain(`id="panel-connector"`);
    expect(guide).toContain(`id="panel-local-bridge"`);
    expect(guide).toContain(`id="panel-direct"`);
  });

  it('默认选中连接器路径（PREFERRED_SOURCE_KIND）—— 与接口缺省值不同，界面策略不落到接口上', () => {
    expect(PREFERRED_SOURCE_KIND).toBe('connector');
    expect(guide).toMatch(/class="mode on" id="m-connector"/);
  });

  it('A 卡引导用户去**自己的应用**里连接，而不是在本页填密码', () => {
    expect(guide).toContain('WorkBuddy 的「连接器」');
    expect(guide).toContain('不要把密码填到本页');
    expect(guide).toContain('你自己的客户端');
  });

  it('B 卡给出**可复制的本机命令**，并点明授权码留在本机（含国内邮箱授权码坑）', () => {
    expect(guide).toContain('id="localCmd"');
    expect(guide).toContain('id="copyCmd"');
    expect(guide).toContain('himalaya');
    expect(guide).toContain('客户端授权码');
    expect(guide).toContain('不上传');
  });

  it('B 卡对无等价工具的通道如实说明（不提供假入口）', () => {
    expect(guide).toContain('暂无等价本机工具');
    expect(guide).toContain('不提供假入口');
  });

  it('C 卡显式声明凭据将上传平台（凭据去向不得含糊）', () => {
    expect(guide).toContain('凭据会上传到我方平台');
  });

  it('**A/B 不在本页收集凭据**：collect() 在非 direct 路径下 credentials 恒为 null', () => {
    expect(guide).toContain("if (mode !== 'direct')");
    expect(guide).toContain('credentials: null');
  });

  it('提交时显式携带 source_kind（不依赖接口缺省值兜底）', () => {
    // 校验与确认两处提交都要带
    const hits = guide.match(/source_kind: mode/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('三形态的成功语义分开显示（direct=平台实测 / A·B=待确认），不得统一写成「已验证」', () => {
    expect(guide).toContain('平台侧探测通过');
    expect(guide).toContain('待你在自己那侧确认');
    expect(guide).toContain('res.pending');
  });

  it('步骤②说明按路径分路（平台无从代验的要写清楚）', () => {
    expect(guide).toContain('验证方式按路径分路');
    expect(guide).toContain('无法代验');
  });

  it('切换路径时只显示当前路径的表单（否则用户在 A 路径下把密码填进 C 的表单）', () => {
    expect(guide).toContain("$('panel-' + k).hidden = k !== m");
    expect(guide).toContain('三条路并存会让用户在 A 路径下把密码填进 C 的表单');
  });
});

describe('配置台：形态与凭据去向在管理面可见', () => {
  it('表格新增「接入形态（凭据在谁那里）」与「验证」两列', () => {
    expect(cfg).toContain('接入形态（凭据在谁那里）');
    expect(cfg).toContain('<th>验证</th>');
    expect(cfg).toContain('colspan="8"');
  });

  it('形态文案按 source_kind 映射（连接器/本机桥/平台直连三种去向各自表述）', () => {
    expect(cfg).toContain('连接器（我方不持有凭据）');
    expect(cfg).toContain('本机桥（凭据在你本机）');
    expect(cfg).toContain('平台直连（凭据加密存于平台）');
  });

  it('「待确认」与「已验证」分开渲染（三形态成功语义不同，混用＝谎报）', () => {
    expect(cfg).toContain('verified_kinds');
    expect(cfg).toContain("pending");
    expect(cfg).toContain('待确认');
    expect(cfg).toContain('未验证');
  });

  it('配置台表单**显式**声明 source_kind=direct（本表单即平台直连路径）', () => {
    expect(cfg).toContain("source_kind: 'direct'");
  });
});
