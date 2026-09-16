// test/sync/fxiaokeRead.test.js — P0-2：readIncremental 禁止桩返回 ok:true+rows:[]
// 官方接口形状实证：POST https://open.fxiaoke.com/cgi/crm/v2/data/query
//   body { corpAccessToken, corpId, currentOpenUserId,
//          data:{ dataObjectApiName, search_query_info:{ limit, offset, filters:[{field_name, field_values, operator}] } } }
//   响应 { data:{ total, offset, limit, dataList[] }, errorCode, errorMessage }
import { describe, it, expect } from 'vitest';
import { createFxiaokeProvider } from '../../src/sync/fxiaoke.js';

const fullCreds = { appId: 'a', appSecret: 's', permanentCode: 'c', corpId: 'corp-1', currentOpenUserId: 'u-1' };
const authPost = async () => ({ access_token: 'tok-1', expires_in: 7200 });

describe('fxiaoke readIncremental（P0-2 去桩）', () => {
  it('无 corpId/currentOpenUserId → ok:false（不再假健康 ok:true+空行）', async () => {
    const p = createFxiaokeProvider({
      creds: { appId: 'a', appSecret: 's', permanentCode: 'c' },
      httpPost: authPost,
    });
    const r = await p.readIncremental({ object: 'AccountObj' });
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
    expect(String(r.error)).toContain('credentials_incomplete');
  });

  it('缺 object → ok:false（object_missing，不静默空转）', async () => {
    const p = createFxiaokeProvider({ creds: fullCreds, httpPost: authPost });
    const r = await p.readIncremental({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('object_missing');
  });

  it('凭据齐备 → 真实 POST /cgi/crm/v2/data/query，解析 dataList 并推进游标', async () => {
    const calls = [];
    const p = createFxiaokeProvider({
      creds: fullCreds,
      httpPost: async (url, body) => {
        calls.push({ url, body });
        if (url.endsWith('/cgi/corpAccessToken/get')) return { access_token: 'tok-1', expires_in: 7200 };
        return {
          errorCode: 0,
          data: {
            total: 2,
            dataList: [
              { _id: 'A1', name: '客户A', last_modified_time: '2026-09-01T10:00:00Z' },
              { _id: 'A2', name: '客户B', last_modified_time: '2026-09-02T10:00:00Z' },
            ],
          },
        };
      },
    });
    const r = await p.readIncremental({ object: 'AccountObj', cursor: '2026-08-31T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(2);
    expect(r.cursor).toBe('2026-09-02T10:00:00Z'); // 游标推进到本批最大 since
    const q = calls.find((c) => c.url.endsWith('/cgi/crm/v2/data/query'));
    expect(q).toBeTruthy();
    expect(q.body.corpAccessToken).toBe('tok-1');
    expect(q.body.corpId).toBe('corp-1');
    expect(q.body.currentOpenUserId).toBe('u-1');
    expect(q.body.data.dataObjectApiName).toBe('AccountObj');
    expect(q.body.data.search_query_info.filters[0]).toEqual({
      field_name: 'last_modified_time', field_values: ['2026-08-31T00:00:00Z'], operator: 'GTE',
    });
  });

  it('无游标（首轮全量）→ filters 为空数组且游标推进', async () => {
    const calls = [];
    const p = createFxiaokeProvider({
      creds: fullCreds,
      httpPost: async (url, body) => {
        calls.push({ url, body });
        if (url.endsWith('/cgi/corpAccessToken/get')) return { access_token: 'tok-1', expires_in: 7200 };
        return { errorCode: 0, data: { dataList: [{ _id: 'A1', last_modified_time: '2026-09-05T00:00:00Z' }] } };
      },
    });
    const r = await p.readIncremental({ object: 'AccountObj' });
    expect(r.ok).toBe(true);
    const q = calls.find((c) => c.url.endsWith('/cgi/crm/v2/data/query'));
    expect(q.body.data.search_query_info.filters).toEqual([]);
    expect(r.cursor).toBe('2026-09-05T00:00:00Z');
  });

  it('业务错误码非 0 → ok:false 带 errorMessage（不伪装空批）', async () => {
    const p = createFxiaokeProvider({
      creds: fullCreds,
      httpPost: async (url) => (url.endsWith('/cgi/corpAccessToken/get')
        ? { access_token: 'tok-1', expires_in: 7200 }
        : { errorCode: 10001, errorMessage: 'invalid corpAccessToken' }),
    });
    const r = await p.readIncremental({ object: 'AccountObj' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('10001');
  });

  it('HTTP 抛错 → ok:false 带原因（不静默）', async () => {
    const p = createFxiaokeProvider({
      creds: fullCreds,
      httpPost: async (url) => {
        if (url.endsWith('/cgi/corpAccessToken/get')) return { access_token: 'tok-1', expires_in: 7200 };
        throw new Error('socket hang up');
      },
    });
    const r = await p.readIncremental({ object: 'AccountObj' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('socket hang up');
  });

  it('verifyAuth 失败（无凭据）→ ok:false 且不发起查询', async () => {
    let calls = 0;
    const p = createFxiaokeProvider({
      creds: fullCreds,
      httpPost: async () => { calls++; throw new Error('auth down'); },
    });
    const r = await p.readIncremental({ object: 'AccountObj' });
    expect(r.ok).toBe(false);
    expect(calls).toBe(1); // 仅 auth 一次，无后续查询
  });
});
