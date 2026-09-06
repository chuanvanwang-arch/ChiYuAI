// test/web/pipeline-new-deal.test.js — P4 守卫：终结"新增不落库"
// 设计输入：docs/specs/2026-08-27-ui-nav-standards-design.md §P4（真实新增写通道）
// 论证：POST /api/particles 端点 + 第0闸（LEAD_FOLLOW_UP）已在 routes.js 落地（src/http/routes.js:177）；
//   data-particle-create 通用白名单 Action 已落地（src/action/seed-actions.js:19）。
//   唯一缺口 = 前端无新建入口 → 本测试锁定 pipeline.html 必须提供「＋新建商机」按钮并真实调 POST。
// 纯静态断言（不依赖 PG），对齐 test/web/nav-path.test.js 范式。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const web = join(process.cwd(), 'src/web');
const HTML = 'pipeline.html';

describe('P4 pipeline new-deal entry', () => {
  const p = join(web, HTML);
  const src = existsSync(p) ? readFileSync(p, 'utf8') : '';

  it('pipeline.html 存在且已接入统一壳', () => {
    expect(existsSync(p), `${HTML} 缺失`).toBe(true);
    expect(src).toContain("from '/portal/layout.js'");
    expect(src).toContain('injectLayout()');
  });

  it('提供「＋新建商机」按钮（终结"新增不落库"的入口）', () => {
    expect(src, 'pipeline.html 缺少新建商机按钮').toMatch(/新建商机|＋新建商机|新建线索/);
    // 按钮/触发器须可定位（id 或 data 属性）
    expect(src, '新建按钮无可定位标识').toMatch(/id="newDeal|data-new-deal|newDealBtn/);
  });

  it('新建提交真实调用 POST /api/particles 且 type=CRM_DEAL', () => {
    expect(src, 'pipeline.html 未调用 POST /api/particles').toContain("fetch('/api/particles'");
    // 写通道必须声明 method POST（读直连是 GET）
    expect(src, 'POST 方法缺失').toMatch(/method:\s*['"]POST['"]/);
    // 新建的是商机粒子（非用旧 leads 脏值）
    expect(src, '新建未指定 CRM_DEAL 粒子类型').toContain('CRM_DEAL');
  });

  it('写通道带认证头（第0闸前需 resolveMe，无 token 一律 401）', () => {
    // 至少其一：读 localStorage token 并塞 Authorization，或显式 authorization 头
    const hasAuth = /authorization/i.test(src) || /localStorage\.getItem\(['"]token['"]\)/.test(src);
    expect(hasAuth, '新建提交未携带认证（第0闸前 resolveMe 会因无 token 返回 401）').toBe(true);
  });
});
