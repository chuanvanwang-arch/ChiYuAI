// test/web/onboardingGuidePage.test.js — T8：网页全屏 Onboarding 向导（设计 §4.5.2-B / §4.5.1 三步）
// 判据：
//   ① 步骤①问卷：常用邮箱 / 企业微信·飞书·钉钉 / 个人微信（可选）/ 日历（可选），且**全部可跳过**；
//   ② 步骤②：verifyScope **真实探测** + fail-closed 文案（credentials_missing / probe_not_implemented）+ 明示「只读」；
//   ③ 步骤③：一键「确认接入」→ POST /api/channels/connect（与 WorkBuddy 入口**同一后端引擎**）；
//   ④ **验证不得有副作用**：步骤② 必须走 verify_only（否则「验证」会真的落凭据/落库）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { KIND_PROBE } from '../../src/channels/kinds.js';
import { PROBE_REQUIRED_FIELDS } from '../../src/channels/probes.js';

const src = readFileSync(new URL('../../src/web/onboarding-guide.html', import.meta.url), 'utf8');
const routesSrc = readFileSync(new URL('../../src/http/routes.js', import.meta.url), 'utf8');

// 页面内联的必填字段表（与后端同源，见下方跨层守卫）
function pageCredFields() {
  const m = src.match(/const CRED_FIELDS = (\{[\s\S]*?\n    \});/);
  if (!m) throw new Error('未找到 CRED_FIELDS —— 跨层守卫失去锚点');
  return JSON.parse(m[1].replace(/'/g, '"').replace(/,(\s*\})/g, '$1'));
}

describe('onboarding-guide.html 向导三步', () => {
  it('步骤① 问卷含邮箱/企业微信，且全默认可跳过', () => {
    expect(src).toContain('常用邮箱');
    expect(src).toContain('企业微信');
    expect(src).toContain('全部跳过');
    expect(src).toContain('未接入不影响核心功能');
  });

  it('个人微信**不做假接通**：明示无开放 API，且不作为通道提交', () => {
    // 红线（设计 §3.4）：个人微信无开放 API。此前向导把「个人微信」当 generic-wechat 提交，
    //   必然探测失败且把失败原因误导为「企微凭据错」——属**假失败**（比假绿更隐蔽）。
    expect(src).toContain('无开放 API');
    expect(src).toContain('不做假接通');
    const collect = src.slice(src.indexOf('function collect()'), src.indexOf('function tenantId()'));
    // collect 只产出 4 个**有开放 API** 的真通道（个人微信不在其中）
    const kinds = [...collect.matchAll(/kind: '([\w-]+)'/g)].map((m) => m[1]);
    expect(kinds.sort()).toEqual(['generic-calendar', 'generic-email', 'generic-meeting', 'generic-wechat']);
    expect(collect).toContain("label: '企业微信'");   // 企微以 corpid+secret 成对提交
    expect(collect).toContain('corp_id: wx');
    expect(collect).toContain('secret: ws');
  });

  it('步骤② 含 verifyScope 真探测与 fail-closed 文案（可区分：不全/连不通/密码错）', () => {
    expect(src).toContain('真实探测');
    expect(src).toContain('fail-closed');
    expect(src).toContain('credentials_incomplete');  // 缺哪个字段要说清
    expect(src).toContain('connect_failed');          // 连不通
    expect(src).toContain('auth_failed');             // 账号/密码错
    expect(src).toContain('当前只读（L1）');
  });

  it('凭据必填字段与后端探针要求**逐通道严格一致**（漂移 ⇒ 用户填完仍被拒且无提示）', () => {
    const page = pageCredFields();
    expect(Object.keys(page).sort()).toEqual(Object.keys(KIND_PROBE).sort());
    for (const [kind, fields] of Object.entries(page)) {
      expect(fields, `${kind} 与后端不一致`).toEqual(PROBE_REQUIRED_FIELDS[KIND_PROBE[kind]]);
    }
  });

  it('邮箱服务器自动推导（host 可留空）+ 确认前明示连接目标、不回显密码', () => {
    expect(src).toContain('deriveImapHost');
    expect(src).toContain('targetOf');           // 连接目标可见（用户知情后确认）
    const t = src.slice(src.indexOf('function targetOf'), src.indexOf('function renderPlan'));
    expect(t).not.toContain('cr.pass');          // 目标函数绝不碰密码
    expect(t).not.toContain('cr.token');
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
