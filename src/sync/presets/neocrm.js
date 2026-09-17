// src/sync/presets/neocrm.js — 销售易（Neocrm）接入预设（纯配置，非产品代码）
// 经 src/sync/factory.js 的 generic-rest 通用适配器接入；差异全部在此 descriptor 表达。
// 鉴权：appId/appSecret/userName → getToken → data.accessToken（注入自定义头 X-Access-Token）。
// 凭据形状：{ appId, appSecret, userName }
export default {
  kind: 'generic-rest',
  label: '销售易 Neocrm',
  base: 'https://api.xiaoshouyi.com',
  auth: {
    type: 'token-flow',
    steps: [
      {
        url: 'https://api.xiaoshouyi.com/api/openapi/token/getToken',
        method: 'POST',
        body: {
          appId: '{cred.appId}',
          appSecret: '{cred.appSecret}',
          userName: '{cred.userName}',
        },
        tokenPath: 'data.accessToken',
      },
    ],
    inject: { target: 'header', key: 'X-Access-Token', prefix: '' },
  },
  request: {
    method: 'POST',
    urlTemplate: '{base}/api/openapi/data/queryV2',
    // 每个 object 在 request.bodyTemplate 中声明查询体（objName + where）
  },
  response: { rowsPath: 'data.records', cursorPath: 'data.nextCursor' },
  objects: [
    { name: 'Account', label: '客户', since_field: 'lastModifiedDate',
      request: { bodyTemplate: { objectApiName: 'Account', where: 'lastModifiedDate > {cursor}', pageSize: 100 } } },
    { name: 'Lead', label: '线索', since_field: 'lastModifiedDate',
      request: { bodyTemplate: { objectApiName: 'Lead', where: 'lastModifiedDate > {cursor}', pageSize: 100 } } },
    { name: 'Contact', label: '联系人', since_field: 'lastModifiedDate',
      request: { bodyTemplate: { objectApiName: 'Contact', where: 'lastModifiedDate > {cursor}', pageSize: 100 } } },
  ],
};
