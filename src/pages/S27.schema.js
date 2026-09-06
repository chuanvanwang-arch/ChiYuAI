// src/pages/S27.schema.js — S27 粒子模型/本体/词汇配置（/config/ontology）
// 定位：粒子模型 / 本体 / 词汇表维护（写时向量化，"写库即构建"）
// 端点：[新增] GET/PUT /api/config/ontology（落 ontology 表，复用 src/ontology/）
// 组件：table(词汇/本体项) + attr-field(term/synonym/embedding_ref) + select(粒子类型映射)
// 权限：sysadmin
// 对齐：ai-ontology-vector-build「写库即构建」
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '粒子模型/本体/词汇配置',
  navigation: { to: '/config/ontology' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '词汇/本体项',
      dataBinding: { source: 'particle', particleType: 'CRM_KNOWLEDGE', filters: [], metrics: [], columns: ['term', 'synonym', 'particle_type', 'embedding_ref'] },
    },
    { kind: 'attr-field', attrSlug: 'term', attrType: 'text', label: '术语', attr: { slug: 'term', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'synonym', attrType: 'text', label: '同义词', attr: { slug: 'synonym', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'embedding_ref', attrType: 'text', label: '向量引用', attr: { slug: 'embedding_ref', data_origin: 'rule' } },
    {
      kind: 'select',
      label: '粒子类型映射',
      name: 'particleTypeMap',
      dataBinding: { source: 'particle', particleType: 'CRM_KNOWLEDGE', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S27 schema 非法: ' + v.errors[0]);