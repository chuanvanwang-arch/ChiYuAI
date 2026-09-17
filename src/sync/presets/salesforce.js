// src/sync/presets/salesforce.js — Salesforce 接入预设（纯配置，非产品代码）
// 经 src/sync/factory.js 的 generic-rest 通用适配器接入；差异全部在此 descriptor 表达。
// 鉴权：OAuth2 client_credentials → 取 access_token（注入 Authorization: Bearer）+ instance_url（作为 API 基址）。
// 凭据形状：{ clientId, clientSecret }（生产应来自凭据保险库，经 config_store 注入，不落代码）
export default {
  kind: 'generic-rest',
  label: 'Salesforce',
  // API 基址来自令牌响应里的 instance_url（token-flow 第 0 步 outputVars 捕获为 steps[0].instanceUrl）
  base: '{steps[0].instanceUrl}',
  auth: {
    type: 'token-flow',
    steps: [
      {
        url: 'https://login.salesforce.com/services/oauth2/token',
        method: 'POST',
        body: {
          grant_type: 'client_credentials',
          client_id: '{cred.clientId}',
          client_secret: '{cred.clientSecret}',
        },
        tokenPath: 'access_token',
        outputVars: { instanceUrl: 'instance_url' },
        expiresInPath: 'expires_in',
      },
    ],
    inject: { target: 'header', key: 'Authorization', prefix: 'Bearer ' },
  },
  request: {
    method: 'GET',
    // SOQL 经 query 端点；{soql} 来自 objects[].soql
    urlTemplate: '{base}/services/data/v60.0/query?q={soql}',
  },
  response: { rowsPath: 'records' },
  objects: [
    { name: 'Account', label: '客户', since_field: 'SystemModstamp',
      soql: "SELECT Id,Name,SystemModstamp FROM Account WHERE SystemModstamp > {cursor}" },
    { name: 'Lead', label: '线索', since_field: 'SystemModstamp',
      soql: "SELECT Id,Company,SystemModstamp FROM Lead WHERE SystemModstamp > {cursor}" },
    { name: 'Contact', label: '联系人', since_field: 'SystemModstamp',
      soql: "SELECT Id,LastName,SystemModstamp FROM Contact WHERE SystemModstamp > {cursor}" },
  ],
};
