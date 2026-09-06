// test/helpers/seedFixture.js — 测试夹具：幂等重灌种子（供 TRUNCATE 后的依赖种子用例自足）
// 用法：依赖 particles 种子的测试文件在 beforeAll/beforeEach 调 await reseedBase()；
// 与 db/seed.sql 幂等（WHERE NOT EXISTS）语义一致，可反复调用、不设 loaded 去重——
// 共享真实 PG 下测试文件按字母序执行，前序文件 TRUNCATE 会清掉种子，后序文件必须每次真灌。
// seed.sql 自身 WHERE NOT EXISTS 已保证重复执行零副作用（仅补缺失行）。
import { readFileSync } from 'node:fs';
import { query } from '../../src/db.js';

let cachedSql = null;

export async function reseedBase() {
  cachedSql ||= readFileSync(new URL('../../db/seed.sql', import.meta.url), 'utf8');
  await query(cachedSql);
  return true;
}

// 上下文分层测试自包含夹具：actorRole(scope.js) 依赖 CRM_PERSON 粒子解析角色，
// 而生产 seed.sql 不含 CRM_PERSON；本函数幂等补入角色/组织/商机，使 context.test.js
// 的集成用例（buildContextBlock 角色解析 + enforceScope 第1闸越权判定）数据自足。
// 不污染生产 seed.sql 契约（仅测试库 INSERT ON CONFLICT DO NOTHING）。
export async function seedContextProfiles() {
  await query(`
    INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('00000000-0000-0000-0000-00000000a0a1', 'system','CRM_PERSON','person-sales-a', '销售A','ACTIVE','{"role_tags":["sales"],"org_id":"org-hq"}', now(), now()),
    ('00000000-0000-0000-0000-00000000a0a2', 'system','CRM_PERSON','person-sales-b', '销售B','ACTIVE','{"role_tags":["sales"],"org_id":"org-hq"}', now(), now()),
    ('00000000-0000-0000-0000-00000000a0a3', 'system','CRM_PERSON','person-manager', '经理', 'ACTIVE','{"role_tags":["manager"],"org_id":"org-hq"}', now(), now()),
    ('00000000-0000-0000-0000-00000000a0a4', 'system','CRM_PERSON','person-exec',    '高管', 'ACTIVE','{"role_tags":["exec"],"org_id":"org-hq"}', now(), now()),
    ('00000000-0000-0000-0000-00000000a0a5', 'system','CRM_PERSON','person-finance', '财务', 'ACTIVE','{"role_tags":["finance"],"org_id":"org-hq"}', now(), now()),
    ('00000000-0000-0000-0000-00000000a0b1', 'system','CRM_ORGANIZATION','org-hq',    '总部', 'ACTIVE','{"parent_id":null}', now(), now()),
    ('00000000-0000-0000-0000-00000000a0c1', 'system','CRM_DEAL','deal-fixture', '夹具商机','ACTIVE','{"name":"夹具商机","stage":"lead","owner_id":"person-sales-a","account_id":"a1111111-1111-1111-1111-111111111101"}', now(), now())
    ON CONFLICT (id) DO NOTHING;
  `);
  return true;
}