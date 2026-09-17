// src/sync/presets/fxiaoke.js — 纷享逍客（FXiaoke）接入预设（纯配置，非产品代码）
// 经 src/sync/factory.js 的 generic-rest 通用适配器接入；差异全部在此 descriptor 表达。
// 鉴权（**两步串联**，通用 token-flow 模型支撑，非产品专属代码）：
//   第 0 步 get_app_token（corpId/appId/appSecret/permanentCode）→ appToken（outputVars 捕获）
//   第 1 步 get_corp_token（appId/appToken/openUserId/corpId）→ corpAccessToken
//   corpAccessToken 由请求体模板 {token} 承载（inject.target='none'）。
// 凭据形状：{ corpId, appId, appSecret, permanentCode, openUserId }
export default {
  kind: 'generic-rest',
  label: '纷享逍客 FXiaoke',
  base: 'https://open.fxiaoke.com',
  auth: {
    type: 'token-flow',
    steps: [
      {
        url: 'https://open.fxiaoke.com/cgi/open/openapi',
        method: 'POST',
        body: {
          appId: '{cred.appId}',
          appSecret: '{cred.appSecret}',
          permanentCode: '{cred.permanentCode}',
          action: 'get_app_token',
        },
        tokenPath: 'appToken',
        outputVars: { appToken: 'appToken' },
      },
      {
        url: 'https://open.fxiaoke.com/cgi/open/openapi',
        method: 'POST',
        body: {
          appId: '{cred.appId}',
          appToken: '{steps[0].appToken}',
          action: 'get_corp_token',
          corpId: '{cred.corpId}',
          openUserId: '{cred.openUserId}',
        },
        tokenPath: 'corpAccessToken',
        outputVars: { corpToken: 'corpAccessToken' },
      },
    ],
    inject: { target: 'none' }, // token 经 body 模板 {token} 注入，不额外加头/查询参
  },
  request: {
    method: 'POST',
    urlTemplate: '{base}/cgi/open/openapi',
    // 每个 object 在 request.bodyTemplate 中声明 data 查询体（objName + where + corpAccessToken）
  },
  response: { rowsPath: 'data.dataList', cursorPath: 'data.nextCursor' },
  objects: [
    { name: 'Account', label: '客户', since_field: 'last_modified_time',
      request: { bodyTemplate: { action: 'v2/data/query', corpAccessToken: '{token}', data: { objName: 'Account', where: 'last_modified_time > {cursor}', limit: 100 } } } },
    { name: 'Lead', label: '线索', since_field: 'last_modified_time',
      request: { bodyTemplate: { action: 'v2/data/query', corpAccessToken: '{token}', data: { objName: 'Lead', where: 'last_modified_time > {cursor}', limit: 100 } } } },
    { name: 'Contact', label: '联系人', since_field: 'last_modified_time',
      request: { bodyTemplate: { action: 'v2/data/query', corpAccessToken: '{token}', data: { objName: 'Contact', where: 'last_modified_time > {cursor}', limit: 100 } } } },
  ],
};
