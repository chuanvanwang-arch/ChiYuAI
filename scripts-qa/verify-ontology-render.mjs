// scripts-qa/verify-ontology-render.mjs — 验证 ontologyConfigRender.js 浏览器可加载且导出齐全（脚本文件规避 bash 转义）
import { renderVocabulary, renderModelSnapshot, validateVocabularyPatch, VOCAB_EDITABLE_FIELDS, VOCAB_STATES, CORE_PARTICLE_IDS, PARTICLE_MODEL } from '../src/portal/ontologyConfigRender.js';

console.log('7 导出加载 OK');
const h = renderVocabulary([{ id: 'v1', term: '商机', type: 'business', layer: 'L1', state: 'ACTIVE' }]);
console.log('renderVocabulary 含商机:', h.includes('商机'));
console.log('renderModelSnapshot len>200:', renderModelSnapshot().length > 200);
console.log('validateVocabularyPatch ok:', validateVocabularyPatch({ term: 'x' }).ok === true);
console.log('VOCAB_EDITABLE_FIELDS:', VOCAB_EDITABLE_FIELDS.join('/'));
console.log('VOCAB_STATES:', VOCAB_STATES.join('/'));
console.log('CORE_PARTICLE_IDS 数:', CORE_PARTICLE_IDS.length);
console.log('PARTICLE_MODEL 键:', Object.keys(PARTICLE_MODEL).join(','));