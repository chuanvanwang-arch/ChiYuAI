// test/web/account360ExternalComms.test.js
// 需求② §5 前台呈现：account-360「外部沟通维度」区块（T8 第三页）守卫。
// 判据（防死区/防假绿）：
//   ① 区块真实存在于 account-360.html，且在画像加载后被**注入**（不是只写在注释里）；
//   ② 页面读取的 enrichment 键集与 src/channels/kinds.js 的 ENRICHMENT_KEY **严格相等**——
//      「页面读错键 / 只读一半键」是静默死区（数据在库里、页面永远空），必须被守卫钉住；
//   ③ 空态不是死区：说明「为什么空」+ 给出可行动入口（通道配置台/接入向导），未接入不阻塞核心功能；
//   ④ 只读语义与转义（外部内容一律经 esc；不落原始明文）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ENRICHMENT_KEY } from '../../src/channels/kinds.js';

const src = readFileSync(new URL('../../src/web/account-360.html', import.meta.url), 'utf8');

describe('account-360「外部沟通维度」区块', () => {
  it('含区块标题与渲染函数（真实呈现代码，非仅注释）', () => {
    expect(src).toContain('外部沟通维度');
    expect(src).toMatch(/function\s+renderExternalComms\s*\(/);
    expect(src).toContain("card.className = 'pg-extcomms-card'");
  });

  it('读取的 enrichment 键集与单一事实源严格相等（缺项/幽灵项/拼错键即红）', () => {
    const pageKeys = [...src.matchAll(/\{\s*key:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(pageKeys.length).toBe(4); // 无重复登记
    expect(pageKeys.slice().sort()).toEqual(Object.values(ENRICHMENT_KEY).sort());
  });

  it('四键均被消费（日历/会议/企微不得被漏读——否则其信号在 360 永远不可见）', () => {
    for (const key of Object.values(ENRICHMENT_KEY)) {
      expect(src).toContain(`'${key}'`);
    }
    expect(src).toContain('payload.enrichment'); // 数据源＝账户 payload（与 T7 落点一致）
  });

  it('注入点存在且有防双份守卫（renderer 与 JS 注入二选一）', () => {
    expect(src).toMatch(/if\s*\(!profileRoot\.querySelector\('\.pg-extcomms-card'\)\)/);
    expect(src).toMatch(/profileRoot\.appendChild\(renderExternalComms\(/);
  });

  it('空态非死区：说明不阻塞核心功能 + 指向通道配置台与接入向导', () => {
    expect(src).toContain('不影响核心功能');
    expect(src).toContain('/channel-config.html');
    expect(src).toContain('/onboarding-guide.html');
  });

  it('只读语义明示（系统不写回客户侧系统）', () => {
    expect(src).toContain('不写回客户侧系统');
    expect(src).toContain('只读观察');
  });

  it('外部内容一律转义（esc(x) 包裹，防注入）+ 时间经 fmtTime', () => {
    expect(src).toContain('esc(fmtTime(r.ts))');
    for (const f of ['esc(r.channel)', 'esc(r.subject)', 'esc(r.kind)', 'esc(r.domain)']) {
      expect(src).toContain(f);
    }
  });

  it('时间倒序 + 条数上界（避免长表拖死页面）', () => {
    expect(src).toContain('rows.sort(');
    expect(src).toContain('rows.slice(0, 50)');
  });
});
