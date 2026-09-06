// src/pages/S24.schema.js — S24 粒子属性元模型配置（/config/meta-attr）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S24 + 计划 §4 Task34
// 定位：动态对象/属性/维度建模；**每个属性必须声明 data_origin（四查①/②/③/④）杜绝孤儿字段**
// 端点：GET /api/meta-attr(routes.js:52) + POST/PUT（写经 data-particle-attr-update 第0闸）
// 组件：table(粒子类型) + subtable(属性列表) + attr-field(新增属性：slug/type/title/permission/data_origin/semantic_tag/ai_axis/confidence_threshold/source_badge)
//       + select(角色权限 hidden/readonly/edit) + badge(来源徽标实时预览，复用 sourceClassify.js)
// 权限：sysadmin（结构变更）
// 对齐：§2.5 字段采集四查 + §6.2 七维 Schema 载体；属性清单以 particleModel.js coreAttributes 为唯一事实源
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '粒子属性元模型',
  navigation: { to: '/config/meta-attr' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '粒子类型',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['particle_type', 'attr_count', 'status'] },
    },
    {
      kind: 'subtable',
      title: '属性列表',
      mainColumn: 'attr_slug',
      subColumns: ['attr_type', 'data_origin', 'permission', 'semantic_tag'],
      subRows: 'attrs',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    // 新增属性 form（四查字段配置：data_origin 第一公民）
    { kind: 'attr-field', attrSlug: 'attr_slug', attrType: 'text', label: '属性 slug', attr: { slug: 'attr_slug', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'attr_type', attrType: 'select', label: '属性类型', attr: { slug: 'attr_type', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'data_origin', attrType: 'select', label: '数据来源(①人工②AI③规则④外部)', attr: { slug: 'data_origin', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'semantic_tag', attrType: 'select', label: '语义标签', attr: { slug: 'semantic_tag', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'ai_axis', attrType: 'select', label: 'AI 能力轴(仅②时)', attr: { slug: 'ai_axis', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'confidence_threshold', attrType: 'number', label: '置信度阈值', attr: { slug: 'confidence_threshold', data_origin: 'rule' } },
    {
      kind: 'select',
      label: '角色权限',
      name: 'role_perm',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S24 schema 非法: ' + v.errors[0]);