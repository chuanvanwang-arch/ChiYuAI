// src/pages/S34.schema.js — S34 今日优先·高匹配商机明细（FIT 钻取目标）
// 数据面：CRM_DEAL 中 payload.probability >= 0.6；行级 rowLink → /deal-detail.html?id={id}
// 注意：本仓库 S21 已被「方法论 SKILL 注册表」占用（/config/skills 端点），故 FIT 明细页用空闲编号 S34。
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'dashboard',
  title: '今日优先 · 高匹配商机',
  navigation: { to: '/home' },
  layout: { columns: 1, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '赢率≥60% 的高匹配商机',
      dataBinding: {
        source: 'particle', particleType: 'CRM_DEAL', filters: [],
        columns: ['name', 'stage', 'probability', 'amount', 'owner'],
        rowLink: { textField: 'name', idField: 'id', href: '/deal-detail.html?id={id}' },
      },
      metrics: [],
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S34 schema 非法: ' + v.errors[0]);
