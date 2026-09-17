// test/web/channelHintParity.test.js — 两个接入入口的「拒因引导」必须逐字同源
//
// 为什么需要：同一失败（邮箱 auth_failed）在**向导**（onboarding-guide.html）与**配置台**
//   （channel-config.html）各有一条路径。若一处给「须用客户端授权码」、另一处只说 auth_failed，
//   用户在两个页面得到不同解释 → 其中一个入口实际上吞掉了归因（**假失败**），
//   而且这种漂移不会被各自的页面测试发现（各测各的，都绿）。
// 做法：抽取两页 `guidedHint` 函数体 → 归一化空白 → **严格相等**断言；
//   再断言两页都真的**调用**了它（函数存在但没接线＝死代码）。
// ⚠ 分工如实说明：本测试是**静态**守卫（锚住同源与接线）；该函数的**运行期行为**
//   （渲染出的文本是否含可执行动作、是否跨通道误报）由 scripts/verify-onboarding-guide-hints.mjs 覆盖。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const onboard = read('../../src/web/onboarding-guide.html');
const config = read('../../src/web/channel-config.html');

function extractHintFn(html, label) {
  const m = html.match(/function guidedHint\(res, kind\) \{[\s\S]*?\n {4}\}/);
  if (!m) throw new Error(`${label} 未找到 guidedHint —— 守卫失去锚点`);
  // 归一化空白后再比较（缩进/换行差异不算漂移，语义差异算）
  return m[0].split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

describe('通道失败引导：向导 ⇄ 配置台 同源', () => {
  it('两页 guidedHint 函数体逐字一致（话术漂移 ⇒ 同一失败两种解释）', () => {
    expect(extractHintFn(config, 'channel-config.html')).toBe(extractHintFn(onboard, 'onboarding-guide.html'));
  });

  it('两页都真的调用了 guidedHint（不是死代码）', () => {
    expect(onboard).toMatch(/guidedHint\(res, c\.kind\)/);
    expect(config).toMatch(/guidedHint\(res, kind\)/);
  });

  it('引导按通道区分：仅邮箱套授权码话术（跨通道套用＝把人指向错的下一步）', () => {
    const fn = extractHintFn(onboard, 'onboarding-guide.html');
    expect(fn).toContain("kind === 'generic-email'");
    expect(fn).toMatch(/客户端授权码/);
  });

  it('服务端原话（hint）必须原样呈现，不得被本层话术覆盖', () => {
    const fn = extractHintFn(onboard, 'onboarding-guide.html');
    expect(fn).toContain('res.hint');
  });
});
