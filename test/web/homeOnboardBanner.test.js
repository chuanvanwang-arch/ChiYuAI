// test/web/homeOnboardBanner.test.js — 首页「首次接入引导」契约（需求②「开通期系统主动引导」）
//
// 用户诉求原话：「首次登录系统或者使用工具，系统会自动有个向导，建议用户输入常用邮箱地址/密码、
//   企业微信/飞书/钉钉、个人微信（可选），而不是需要人来键入或者进入配置页！！」
//   ⇒ 引导必须**出现在登录落地页（index.html）**，而不是只躺在 /channel-config.html 里等人去找。
//
// 断言面（静态层）：
//   ① 落地页存在引导区块，且**默认隐藏**（hidden）——展示与否由真实通道数决定，不是无脑常驻；
//   ② 展示判据＝本租户零通道（数据源 /api/channels，与配置台/向导同一后端，不另建第二个数据源）；
//   ③ 有两个可行动入口：向导（/onboarding-guide.html）+ 配置台（/channel-config.html）；
//   ④ 必须写明「不接通不影响核心功能」——否则用户会误判为「系统不完整」；
//   ⑤ 读取失败静默（catch 里不得 throws/alert），接入面故障不许拖垮首页 S02 出片。
// ⚠ 本文件只覆盖静态契约；「运行期是否真的渲染/收起」由 scripts/ 的探针或页面实测覆盖。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../src/web/index.html', import.meta.url), 'utf8');
// 判据（本仓纪律）：「代码里有」的断言必须作用于**剥离注释后**的代码体——
//   否则「被注释掉的挂载行」也能让断言变绿（本项目实拍到过的假绿形态）。
const codeOnly = (s) => s.split('\n').filter((l) => !l.trim().startsWith('<!--') && !l.trim().startsWith('//')).join('\n');
const code = codeOnly(html);

describe('首页首次接入引导（需求② 开通期系统主动引导）', () => {
  it('落地页有引导区块且默认隐藏（展示与否由真实通道数决定）', () => {
    expect(html).toContain('id="onboard-banner"');
    const i = html.indexOf('id="onboard-banner"');
    const seg = html.slice(Math.max(0, i - 200), i + 400);
    expect(seg, '引导区块必须默认 hidden，否则对已接入租户是噪音').toContain('hidden');
  });

  it('展示判据＝零通道，数据源 /api/channels（与配置台/向导同一后端，不另建数据源）', () => {
    expect(code).toContain("get('/api/channels')");
    // 有通道 → 收起（hidden = n > 0）；零通道 → 展示
    expect(code).toMatch(/box\.hidden\s*=\s*n\s*>\s*0/);
    // 不得直读 config_store / 不得另调 integration-providers（写面/读面单一）
    expect(code).not.toContain('/api/integration/providers');
  });

  it('两个可行动入口：3 步接入向导 + 通道配置台（避免只提示不出路）', () => {
    expect(html).toContain('/onboarding-guide.html');
    expect(html).toContain('/channel-config.html');
    expect(code).toContain("getElementById('goOnboard')");
  });

  it('文案明示「不接通不影响核心功能」（防「没接通=系统不完整」误判）', () => {
    expect(html).toContain('不接通不影响核心功能');
  });

  it('读取失败静默：不抛错、不 alert（接入面故障不许拖垮首页）', () => {
    // 锚点取**脚本侧**调用（HTML 里的 id 声明在窗口之外，取错锚点会得到假红/假绿）
    const i = code.indexOf("getElementById('onboard-banner')");
    expect(i, '未找到引导脚本的区块锚点').toBeGreaterThan(-1);
    const seg = code.slice(i, i + 900);
    expect(seg).toContain('catch');
    expect(seg).not.toContain('alert(');
    expect(seg).not.toContain('throw');
  });
});
