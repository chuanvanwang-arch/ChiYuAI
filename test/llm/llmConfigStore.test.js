import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../../src/db.js';
import {
  listConfigs, getDefault, getAllActive, getByName,
  upsertConfig, deleteConfig, setDefault,
} from '../../src/llm/llmConfigStore.js';

// ⚠ N6 缺陷修复（2026-09-05）：原为 const TID = 'system'，测试直接以真实 system 租户为沙箱，
//   clean() 按 tenant_id 全量软删 → 把 system 租户的真实 LLM 配置一并 is_deleted=true 且从不回滚。
//   后果：测试库 llm_enabled 恒为 false（全簇降级、整改待办永不生成）；若在生产的库上跑一次本测试，
//   会导致全平台 LLM 静默降级且无告警。改用独立测试租户，system 租户配置永不被本测试触碰。
const TID = 'test-llm-cfg';

async function clean() {
  await query("UPDATE crm.llm_config SET is_deleted=true WHERE tenant_id=$1", [TID]);
}

beforeAll(async () => { await clean(); });
afterAll(async () => { await clean(); });

describe('llmConfigStore', () => {
  it('upsert 首条自动成默认', async () => {
    const c = await upsertConfig({ name: 'siliconflow-main', provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash', base_url: 'https://api.siliconflow.cn/v1', api_key: 'sk-test', is_default: true, tenantId: TID, updated_by: 'test' });
    expect(c.is_default).toBe(true);
    const d = await getDefault(TID);
    expect(d.id).toBe(c.id);
  });

  it('设默认唯一：setDefault 清旧默认', async () => {
    const b = await upsertConfig({ name: 'openai-fb', provider: 'openai', model: 'gpt-4o', api_key: 'sk-b', is_default: false, tenantId: TID, updated_by: 'test' });
    await setDefault(b.id, TID);
    const a = await getDefault(TID);
    expect(a.id).toBe(b.id);
    const all = await getAllActive(TID);
    expect(all.filter((x) => x.is_default).length).toBe(1);
  });

  it('软删默认被拒', async () => {
    const d = await getDefault(TID);
    const r = await deleteConfig(d.id, TID);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cannot_delete_default');
  });

  it('软删非默认成功且列表过滤', async () => {
    const b = await upsertConfig({ name: 'openai-fb', provider: 'openai', model: 'gpt-4o', api_key: 'sk-b', is_default: false, tenantId: TID, updated_by: 'test' });
    const r = await deleteConfig(b.id, TID);
    expect(r.ok).toBe(true);
    const list = await listConfigs(TID);
    expect(list.find((x) => x.id === b.id)).toBeUndefined();
  });

  it('getByName 命中', async () => {
    const c = await upsertConfig({ name: 'siliconflow-main', provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash', api_key: 'sk-test', is_default: true, tenantId: TID, updated_by: 'test' });
    const hit = await getByName('siliconflow-main', TID);
    expect(hit.id).toBe(c.id);
  });
});
