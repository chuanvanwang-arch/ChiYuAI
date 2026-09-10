// 临时 E2E 验证：appendMemory 租户化 + 投影 + 按租户读回隔离 + 凭证安全闸
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native_test';
const { appendMemory, retrieveMemory, projectDecisionMemory } = await import('../src/memory/memoryLog.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); failures++; }
  else console.log('✅', msg);
}

const tid = 'acme-auto';
const uid = 'ACC-' + Date.now();

// ① 干净客户事实记忆：落库 tenant_id / entity_type 正确
const r = await appendMemory({
  topic: 'crm:deal-stage', kind: 'fact',
  payload: { type: 'CRM_DEAL', id: 'DEAL-1', field: 'stage', from: 'S1', to: 'S2', account_id: uid },
  layer: 'L-Workspace', actor: 'verify-bot',
  tenantId: tid, entityId: uid, entityType: 'ACCOUNT', ttlDays: 180,
});
assert(r.ok === true, '① 干净客户记忆 appendMemory ok=true');
const row = r.row;
assert(row.tenant_id === tid, `① 落库 tenant_id==='${tid}' (got ${row.tenant_id})`);
assert(row.entity_id === uid, `① 落库 entity_id==='${uid}'`);
assert(row.entity_type === 'ACCOUNT', `① 落库 entity_type==='ACCOUNT' (got ${row.entity_type})`);

// ② 按租户读回隔离
const mine = await retrieveMemory({ topicLike: 'crm:%', tenantId: tid, limit: 20 });
assert(mine.rows.some((x) => x.id === row.id), '② 同租户 retrieveMemory 能读到刚写入的行');
const other = await retrieveMemory({ topicLike: 'crm:%', tenantId: 'another-tenant', limit: 20 });
assert(!other.rows.some((x) => x.id === row.id), '② 跨租户读不到本租户行（隔离生效）');

// ③ 缺租户兜底：不静默，落 system
const r2 = await appendMemory({ topic: 'crm:nolog', kind: 'event', payload: { note: 'no-tenant' }, layer: 'L-Workspace', actor: 'verify-bot' });
assert(r2.ok === true && r2.row.tenant_id === 'system', '③ 未传 tenantId 兜底落 system（可观测不静默）');

// ④ 凭证安全闸：含凭证文本的 payload 整体硬拒（即便显式也拦）
const r3 = await appendMemory({
  topic: 'crm:cfg', kind: 'fact', payload: { note: 'config saved', client_secret: 'sk-very-secret' },
  layer: 'L-Workspace', actor: 'verify-bot', tenantId: tid, explicit: true,
});
assert(r3.ok === false && r3.code === 'credential', '④ 含凭证键的 payload 被硬拒（安全属性）');

// ⑤ 投影脱敏（纯函数）：四段式 + 凭证字段剥离（不依赖写闸）
const proj = projectDecisionMemory({
  trigger_context: { involved_entities: [{ id: uid, type: 'ACCOUNT' }], conditions_evaluated: [{ name: 'BANT', passed: true }], api_key: 'leak-should-strip' },
  disposition: 'AUTONOMOUS', rationale: '客户已确认预算',
});
assert(typeof proj.summary === 'string' && proj.summary.length > 0, '⑤ 投影生成 summary');
assert(!JSON.stringify(proj).includes('leak-should-strip'), '⑤ 投影输出已剥离 api_key 凭证值');
console.log('   summary 预览:', proj.summary.slice(0, 90));

console.log(failures === 0 ? '\n✅ E2E 全部通过' : `\n❌ E2E ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
