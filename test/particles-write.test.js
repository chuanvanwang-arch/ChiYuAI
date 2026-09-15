// test/particles-write.test.js — Task 3：POST /api/particles 真实写通道（第0闸 + stage 白名单）
// 对齐 http.test.js 注入式范式（createApp().fetch + 真库 plm_test，beforeEach 清库防泄漏）
// 契约：
//  ① 无 token → 401（不再是无认证也放行的 bootstrap 旁路）
//  ② 非 CRM_DEAL（CRM_ACCOUNT）→ 依旧可写（读直连/配置类业务粒子不受影响）
//  ③ CRM_DEAL stage='leads'（脏值/旧习惯）→ 400（normalizeStage 白名单拒）
//  ④ CRM_DEAL stage='lead'（旧英文别名，合法）→ 403 升级（自主引擎无先例→保守升级，第0闸语义）
//  ⑤ normalizeStage 纯函数：缺省补 'S1'；未知值抛错；非 DEAL 透传
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/http/server.js';
import { query } from '../src/db.js';
import { issueToken } from '../src/http/auth.js';
import { normalizeStage, DEAL_STAGES } from '../src/particles/particleRepo.js';

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

// 真实 admin token（第 0 闸依赖 resolveMe 认证；'test-ok' 是无效 token → 401）
const adminToken = () => `Bearer ${issueToken({ username: 't-admin', role: 'admin', display_name: '测试管理员' })}`;

describe('POST /api/particles 写通道（第0闸 + stage 白名单）', () => {
  it('无 token → 401（不再是无认证放行的 bootstrap 旁路）', async () => {
    const app = createApp();
    const res = await app.fetch('/api/particles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'CRM_DEAL', payload: { name: '新商机', stage: 'lead' } }),
    });
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error).toBeTruthy();
  });

  it('CRM_ACCOUNT 带认证 → 201（配置类/非 DEAL 写通道保持可用）', async () => {
    const app = createApp();
    const res = await app.fetch('/api/particles', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: adminToken(),
      },
      body: JSON.stringify({ type: 'CRM_ACCOUNT', payload: { name: '深圳智造', industry: '半导体' } }),
    });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.particle.type).toBe('CRM_ACCOUNT');
  });

  it('CRM_DEAL stage=leads（脏值）→ 400（normalizeStage 白名单拒）', async () => {
    const app = createApp();
    const res = await app.fetch('/api/particles', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: adminToken(),
      },
      body: JSON.stringify({ type: 'CRM_DEAL', payload: { name: '脏数据商机', stage: 'leads' } }),
    });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toContain('非法 stage');
  });

  it('CRM_DEAL stage=lead（合法八段，旧英文别名）→ 403 升级（自主引擎无先例→保守升级，第0闸语义）', async () => {
    const app = createApp();
    const res = await app.fetch('/api/particles', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: adminToken(),
      },
      body: JSON.stringify({ type: 'CRM_DEAL', payload: { name: '彩盒打样', stage: 'lead' } }),
    });
    expect(res.status).toBe(403); // 无先例/条件未填 → mode=escalated（保守升级，非 201）
    const j = await res.json();
    expect(j.error).toContain('第0闸');
    expect(j.decision).toBeTruthy(); // 升级也产出决策（HUMAN 态），供审批流消费
  });

  it('CRM_DEAL 经 bootstrap（系统引导）→ 201，payload.stage=S1 + state=ACTIVE（stage/state 分离）', async () => {
    // bootstrap 是第0闸设计内豁免（系统引导/种子），不绕 stage 白名单（白名单在 createParticle 层）
    // 真实场景：⌘K NL 录入 / 系统引导批量建档
    const app = createApp();
    const res = await app.fetch('/api/particles', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: adminToken(),
        'x-crm-bootstrap': '1',
      },
      body: JSON.stringify({ type: 'CRM_DEAL', payload: { name: '彩盒打样', stage: 'lead' } }),
    });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.particle.type).toBe('CRM_DEAL');
    // 2026-09-01 基线同步：统一术语后 stage 归一为 S 码（src/sales/stageTaxonomy.js 单一事实源），
    // 旧英文值 lead 经 toStageCode 归一为 S1 存储，故断言归一结果而非入参原值。
    expect(j.particle.payload.stage).toBe('S1');
    expect(j.particle.state).toBe('ACTIVE');
  });
});

describe('normalizeStage 纯函数（S_ALL_STAGES 白名单 + 未分类兜底）', () => {
  it('白名单 = S0/S0P + S1–S8（十段，含 S7 输单 / S8 丢单退出边）', () => {
    // 2026-09-01：六段 lead→paid 已废止（旧英文值仅作兼容读别名，不进逻辑）
    // 2026-09-11：前插 S0 公海 / S0P 私海待校验（DEAL_STAGES = S_ALL_STAGES，见 stageTaxonomy.js）
    expect(DEAL_STAGES).toEqual(['S0', 'S0P', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  });
  it('写 S0 公海 / S0P 私海待校验 → 不被判非法 stage', () => {
    expect(normalizeStage('CRM_DEAL', { name: 'x', stage: 'S0' }).stage).toBe('S0');
    expect(normalizeStage('CRM_DEAL', { name: 'x', stage: 'S0P' }).stage).toBe('S0P');
  });
  it('缺省 stage → 兜底 S1（未分类）', () => {
    expect(normalizeStage('CRM_DEAL', { name: 'x' }).stage).toBe('S1');
  });
  it('旧英文值 lead → 归一为 S1（兼容读历史存储值）', () => {
    expect(normalizeStage('CRM_DEAL', { name: 'x', stage: 'lead' }).stage).toBe('S1');
  });
  it('未知 stage → 抛错（含 leads 旧值）', () => {
    expect(() => normalizeStage('CRM_DEAL', { stage: 'leads' })).toThrow('非法 stage');
    expect(() => normalizeStage('CRM_DEAL', { stage: 'won' })).toThrow('非法 stage');
  });
  it('非 CRM_DEAL → 透传不改动', () => {
    const p = { type: 'CRM_QUOTATION', stage: 'draft' };
    expect(normalizeStage('CRM_QUOTATION', p)).toBe(p);
  });
});