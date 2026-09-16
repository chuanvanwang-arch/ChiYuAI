// src/sync/mount.js — 线A 挂载层（把同步内核装到生产触发点）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §6.1 A-B5/A-B6 + §9.1/§9.3 + §13 T06
// 计划：docs/superpowers/plans/2026-09-16-line-a-mount-points.md
//
// 触发点仅两处（零新增定时器）：
//   ① src/scheduler/timers.js ⑩ integration-poll 的增量分支（A-B6）
//   ② src/http/connectorRouter.js POST /api/integration/webhook/:provider 的对象变化路由（A-B5）
//
// 红线：默认 L1（只读）→ 零写入；有效信任档取 min(descriptor, global)（无自动提权）；
//       写操作过决策第 0 闸（L2/L3 每 run 一枚决策）；单目标失败 emit trace + recordFailure 不静默
import { createSyncEngine } from './engine.js';
import { createMappingResolver } from './mapping.js';
import { createEntityResolver } from './resolver.js';
import { createCursorStore } from './cursor.js';

export const SYNC_TRUST_ORDER = ['L1', 'L2', 'L3'];

// —— 有效信任档：min(descriptor, global)。取更严者，descriptor 不可单方面越权（计划 §1 判断 2）——
export function effectiveTrustLevel(descriptorLevel, globalLevel) {
  const d = SYNC_TRUST_ORDER.includes(descriptorLevel) ? descriptorLevel : null;
  const g = SYNC_TRUST_ORDER.includes(globalLevel) ? globalLevel : 'L1'; // 缺省即最严
  if (!d) return g;
  return SYNC_TRUST_ORDER[Math.min(SYNC_TRUST_ORDER.indexOf(d), SYNC_TRUST_ORDER.indexOf(g))];
}

// —— 声明式映射：兼容设计形状 §9.1（mappings[] + fields[].external）与实现形状（fields[].ext）——
// 兼容而非替换：mapping.js 既有形状不被破坏（零回归），设计形状可直落 config_store['sync-mappings']
export function normalizeSyncMappings(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const list = Array.isArray(raw.mappings) ? raw.mappings : null;
  if (!list) {
    // 实现形状：{ [object]: { particle_type, fields:[{ext,particle}] } }
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'version') continue;
      if (!v || typeof v !== 'object' || !Array.isArray(v.fields)) continue;
      out[k] = { ...v, fields: v.fields.map((f) => ({ ...f, ext: f.ext ?? f.external })) };
    }
    return out;
  }
  // 设计形状：{ version, mappings: [{ object, particle_type, direction, identity, fields:[{external,particle}] }] }
  const out = {};
  for (const m of list) {
    if (!m?.object) continue;
    if (m.direction && m.direction !== 'in') continue; // 出向映射由回写 Action 消费，不进读入表
    out[m.object] = {
      particle_type: m.particle_type,
      identity: m.identity || null,
      // 归一化为 mapping.js 消费的形状（fields[].ext）；丢弃 external 键避免同义双键漂移
      fields: (m.fields || []).map(({ external, particle, type, required }) => ({
        ext: external, particle, ...(type ? { type } : {}), ...(required !== undefined ? { required } : {}),
      })),
      filters: m.filters || null,
    };
  }
  return out;
}

// 声明式映射读取（per-tenant，config_store['sync-mappings']）→ 归一化后的映射表
export async function loadSyncMappings({ tenantId = 'system', readConfig } = {}) {
  try {
    const row = await readConfig('sync-mappings', { tenantId });
    return normalizeSyncMappings(row?.value);
  } catch {
    return {}; // fail-closed：读不到映射 → 无映射 → 所有 object 被 mapping 层拒绝（不越权写）
  }
}

// —— descriptor → 同步目标（仅 enabled + 有入向 objects[] + kind 受支持）——
export async function loadTenantSyncTargets({ tenantId = 'system', readConfig, resolveCredentials, factories = {} } = {}) {
  try {
    const row = await readConfig('integration-providers', { tenantId });
    const descs = Array.isArray(row?.value) ? row.value : [];
    const trustRow = await readConfig('sync-trust', { tenantId });
    const globalLevel = trustRow?.value?.default_level || 'L1';
    const creds = resolveCredentials
      ? await resolveCredentials({ tenantId, providerIds: descs.map((d) => d.id) }).catch(() => ({}))
      : {};
    const out = [];
    for (const d of descs) {
      if (!d?.enabled) continue;
      const factory = factories[d.kind];
      if (!factory) continue; // 未知 kind 跳过（不抛，防扫描中断）
      const inbound = (Array.isArray(d.objects) ? d.objects : [])
        .filter((o) => o?.name && (!o.direction || o.direction === 'in'));
      if (!inbound.length) continue; // 无 objects[] → no-op（既有 descriptor 零行为变化）
      out.push({
        id: d.id,
        kind: d.kind,
        provider: factory({ ...d, credentials: (creds && creds[d.id]) || d.credentials || null }),
        objects: inbound,
        trustLevel: effectiveTrustLevel(d.trust_level, globalLevel),
        descriptorLevel: d.trust_level || null,
      });
    }
    return out;
  } catch {
    return []; // fail-closed：读配置失败 → 无目标（定时器不炸）
  }
}

// —— per-tenant 一轮同步（A-B6 分支体）——
export async function runTenantSyncOnce({ tenantId = 'system', targets = [], deps = {} } = {}) {
  const {
    createEngine, pool, mappings = {}, createResolver, createCursor,
    mintDecision, emit, recordFailure, callWriteback, decisionScene = 'integration-sync',
  } = deps;
  const buildEngine = createEngine || (({ provider, trust }) => createSyncEngine({
    provider,
    mapping: createMappingResolver({ mappings }),
    resolver: (createResolver || ((p) => createEntityResolver({ pool: p })))(pool),
    cursor: (createCursor || ((p) => createCursorStore(p)))(pool),
    trust,
    callWriteback,
  }));
  const out = { runs: 0, errors: 0, created: 0, updated: 0, skipped: 0, conflicted: 0, writeback: 0 };
  for (const t of targets) {
    // 防御性再过滤：targets 亦可能来自调用方直接构造（非 loadTenantSyncTargets）
    const inbound = (t.objects || []).filter((o) => o?.name && (!o.direction || o.direction === 'in'));
    for (const obj of inbound) {
      out.runs++;
      try {
        // 有效信任档已由 loadTenantSyncTargets 取 min；此处作为定值注入内核（无提权路径）
        const trust = {
          level: async () => t.trustLevel,
          canWriteBack: async () => t.trustLevel === 'L3',
        };
        // 第 0 闸：L2/L3 每 run 一枚决策（设计 §15「批量入库：一次 run mint 一个决策」）；L1 只读不铸
        // fail-closed：写路径铸不出决策即拒绝本轮（写无决策不落库），由下方 catch 留痕
        let decisionId = null;
        if (t.trustLevel === 'L2' || t.trustLevel === 'L3') {
          const d = await (mintDecision || (async () => ({ decisionId: null })))(
            decisionScene, { tenantId, provider: t.kind, object: obj.name },
          );
          decisionId = d?.decisionId || null;
          if (!decisionId) throw new Error(`decision_required: ${t.trustLevel} 写路径无决策不落库`);
        }
        const engine = buildEngine({ tenantId, target: t, object: obj, provider: t.provider, trust });
        const r = await engine.runOnce({ object: obj.name, tenantId, decisionId });
        out.created += r?.created || 0;
        out.updated += r?.updated || 0;
        out.skipped += r?.skipped || 0;
        out.conflicted += r?.conflicted || 0;
        out.writeback += r?.writeback || 0;
        if (emit) {
          emit('trace', 'sync-run-done', {
            tenant_id: tenantId, provider: t.id, object: obj.name, trust_level: t.trustLevel,
            read: r?.read || 0, created: r?.created || 0, updated: r?.updated || 0,
            skipped: r?.skipped || 0, decision_id: decisionId,
          });
        }
      } catch (err) {
        // G3 不静默：单 target/object 失败留痕，不传染其它目标
        out.errors++;
        if (emit) {
          emit('trace', 'sync-run-failed', {
            tenant_id: tenantId, provider: t.id, object: obj.name, error: String(err?.message || err),
          });
        }
        if (recordFailure) recordFailure('sync-run-failed', err);
      }
    }
  }
  return out;
}

// —— A-B5：单条对象变化事件 → 内核 upsert（admin/sysadmin 闸由路由层把守）——
export async function handleObjectChanged({
  tenantId = 'system', provider, object, row = {}, deps = {},
} = {}) {
  const { mappings = {}, readConfig, createResolver, pool, mintDecision, emit } = deps;
  const def = mappings[object];
  if (!def?.particle_type) return { ok: false, error: 'object_not_mapped' }; // fail-closed：不越权建粒子
  const extId = row.id || row.external_id || (def.identity?.external_id_field ? row[def.identity.external_id_field] : null);
  if (!extId) return { ok: false, error: 'external_id_missing' };
  const trustRow = await (readConfig || (async () => null))('sync-trust', { tenantId }).catch(() => null);
  const level = trustRow?.value?.default_level || 'L1';
  if (level === 'L1') return { ok: true, readOnly: true, externalId: extId }; // 只读观察期：事件不写库
  // 第 0 闸 fail-closed：写路径（L2/L3）铸不出决策 → 不落库。
  // ⚠ 缺 mintDecision 注入视同"铸不出"（漏注入不得静默放开写权限）——与 runTenantSyncOnce 同源红线，两处口径须一致。
  let decisionId = null;
  if (mintDecision) {
    const d = await mintDecision('integration-event', { tenantId, provider, object }).catch(() => ({}));
    decisionId = d?.decisionId || null;
  }
  if (!decisionId) {
    if (emit) emit('trace', 'sync-event-rejected', { tenant_id: tenantId, provider, object, level, reason: 'decision_required' });
    return { ok: false, error: `decision_required: ${level} 写路径无决策不落库` };
  }
  const resolver = (createResolver || ((p) => createEntityResolver({ pool: p })))(pool);
  const payload = (def.fields || []).reduce((acc, f) => {
    const v = row[f.ext];
    if (v !== undefined && v !== null) acc[f.particle] = v;
    return acc;
  }, {});
  const u = await resolver.upsert({
    tenantId, provider, object, externalId: extId, particleType: def.particle_type, payload,
  });
  if (emit) {
    emit('trace', 'sync-event-upsert', {
      tenant_id: tenantId, provider, object, external_id: extId,
      created: !!u?.created, decision_id: decisionId,
    });
  }
  return { ok: true, readOnly: false, created: !!u?.created, particle_id: u?.particle_id, decisionId };
}
