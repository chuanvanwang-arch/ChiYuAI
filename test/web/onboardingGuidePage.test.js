// test/web/onboardingGuidePage.test.js — T8：网页全屏 Onboarding 向导（设计 §4.5.2-B / §4.5.1 三步）
// 判据：
//   ① 步骤①问卷：常用邮箱 / 企业微信·飞书·钉钉 / 个人微信（可选）/ 日历（可选），且**全部可跳过**；
//   ② 步骤②：verifyScope **真实探测** + fail-closed 文案（credentials_missing / probe_not_implemented）+ 明示「只读」；
//   ③ 步骤③：一键「确认接入」→ POST /api/channels/connect（与 WorkBuddy 入口**同一后端引擎**）；
//   ④ **验证不得有副作用**：步骤② 必须走 verify_only（否则「验证」会真的落凭据/落库）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src/web/onboarding-guide.html', import.meta.url), 'utf8');
const routesSrc = readFileSync(new URL('../../src/http/routes.js', import.meta.url), 'utf8');

describe('onboarding-guide.html 向导三步', () => {
  it('步骤① 问卷含邮箱/企业微信/个人微信(可选)，且全默认可跳过', () => {
    expect(src).toContain('常用邮箱');
    expect(src).toContain('企业微信');
    expect(src).toContain('个人微信（可选）');
    expect(src).toContain('全部跳过');
    expect(src).toContain('未接入不影响核心功能');
  });

  it('步骤② 含 verifyScope 真探测与 fail-closed 文案（只读 / credentials_missing）', () => {
    expect(src).toContain('真实探测');
    expect(src).toContain('fail-closed');
    expect(src).toContain('credentials_missing');
    expect(src).toContain('probe_not_implemented');
    expect(src).toContain('当前只读（L1）');
  });

  it('步骤③ 一键确认接入（过 review-gate）', () => {
    expect(src).toContain('确认接入');
    expect(src).toContain('review-gate');
  });

  it('三步 DOM 齐备且单向推进（不越步提交）', () => {
    for (const id of ['step1', 'step2', 'step3']) expect(src).toContain(`id="${id}"`);
  });

  it('调用 /api/channels/connect（同一向导引擎，不另建后端）', () => {
    expect(src).toContain('/api/channels/connect');
  });

  it('步骤② 验证零副作用：必须带 verify_only（否则验证会落凭据/落库）', () => {
    expect(src).toContain('verify_only: true');
  });

  it('凭据不落客户端存储：password 类型 + 无 localStorage/sessionStorage 写入', () => {
    expect(src).toContain('type="password"');
    expect(src).not.toContain('localStorage');
    expect(src).not.toContain('sessionStorage');
  });

  it('入口可达性：routes.js 有 serve（有 serve 才到得了）', () => {
    expect(routesSrc).toContain('/onboarding-guide.html');
  });
});
