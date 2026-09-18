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
// A-B1 单一事实源：描述符的解释权归 providerDescriptor.js（本文件与 enrich 侧共用同一判据）
import { normalizeProviderDescriptors, inboundObjects } from '../connectors/discovery/providerDescriptor.js';
// P1 隐私排除清单（§8.1）：纯函数模块，双线共用同一判定实现
import { createPrivacyFilter, signalsFromSyncRow, PRIVACY_CONFIG_KEY } from '../channels/privacyFilter.js';

export const SYNC_TRUST_ORDER = ['L1', 'L2', 'L3'];

/**
 * P1 隐私过滤器装配（per-tenant 读一次）。
 * 为什么在**装配层**读而不是两个消费点各自读：同一轮里两处若读到不同版本的配置，就会出现
 *   「通道线拦下了、同步线却落了库」——同一份隐私承诺给出两个答案，且两边各自看都是对的。
 * @returns {Promise<ReturnType<typeof createPrivacyFilter>>} 永不抛、永不返回 null（fail-closed）
 */
export async function loadPrivacyFilter({ tenantId = 'system', readConfig } = {}) {
  try {
    const row = await (readConfig || (async () => null))(PRIVACY_CONFIG_KEY, { tenantId });
    return createPrivacyFilter(row?.value);
  } catch {
    // 读不到配置 → 空规则 + config_ok=false（由消费点在游标/trace 留痕）。
    //   ⚠ 不得放大为「全部丢弃」：一次读取抖动会表现为「数据凭空消失」，比不放行更难排查，且不可解释。
    //   ⚠ 也不能与「未配置」混为一谈：未配置是合法状态（config_ok=true），读取失败才是异常（必须留痕）。
    const empty = createPrivacyFilter(null);
    return { ...empty, config_ok: false, load_failed: true };
  }
}

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
// A-B1：归一化与方向判据全部走 providerDescriptor.js（单一事实源），本文件不自行解析描述符
export async function loadTenantSyncTargets({ tenantId = 'system', readConfig, resolveCredentials, factories = {}, channelIngest, emit } = {}) {
  try {
    const row = await readConfig('integration-providers', { tenantId });
    const { descriptors, issues } = normalizeProviderDescriptors(Array.isArray(row?.value) ? row.value : []);
    if (issues.length && typeof emit === 'function') {
      emit('trace', 'integration-providers-invalid', { tenant_id: tenantId, issues });
    }
    const trustRow = await readConfig('sync-trust', { tenantId });
    const globalLevel = trustRow?.value?.default_level || 'L1';
    // P1：本租户一轮同步共用一个隐私过滤器实例（通道线与同步线同一份规则）
    const privacy = await loadPrivacyFilter({ tenantId, readConfig });
    const creds = resolveCredentials
      ? await resolveCredentials({ tenantId, providerIds: descriptors.map((d) => d.id) }).catch(() => ({}))
      : {};
    const out = [];
    for (const d of descriptors) {
      if (!d.enabled) continue;
      const factory = factories[d.kind];
      if (!factory) continue; // 未知 kind 跳过（不抛，防扫描中断）
      const inbound = inboundObjects(d);
      if (!inbound.length) continue; // 无入向 objects[] → no-op（既有 descriptor 零行为变化）
      const trustLevel = effectiveTrustLevel(d.trust_level, globalLevel);
      let provider = factory({ ...d, credentials: (creds && creds[d.id]) || d.credentials || null });
      // 需求② §5（T7）：通道 provider 图谱汇入钩子。**仅**由注入方决定是否包装（本文件不识别通道 kind，
      //   保持通用层零通道专属代码）；包装器为单一读入（同一批 rows 既进内核 upsert 也进汇入）。
      //   包装失败不阻断目标装配（留痕后回落原 provider）。
      if (typeof channelIngest === 'function') {
        try {
          provider = channelIngest({ provider, kind: d.kind, tenantId, trustLevel, emit, privacy }) || provider;
        } catch (e) {
          if (typeof emit === 'function') {
            emit('trace', 'channel-ingest-wrap-failed', { tenant_id: tenantId, provider: d.id, error: String(e?.message || e) });
          }
        }
      }
      out.push({
        id: d.id,
        kind: d.kind,
        provider,
        objects: inbound,
        trustLevel,
        descriptorLevel: d.trust_level || null,
        privacy, // P1：随目标下传，由 runTenantSyncOnce 注入内核（与汇入钩子同源同实例）
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
  const buildEngine = createEngine || (({ provider, trust, privacy }) => createSyncEngine({
    provider,
    mapping: createMappingResolver({ mappings }),
    resolver: (createResolver || ((p) => createEntityResolver({ pool: p })))(pool),
    cursor: (createCursor || ((p) => createCursorStore(p)))(pool),
    trust,
    callWriteback,
    privacy, // P1 隐私排除（§8.1）：不注入即零行为变化（既有调用方/测试不受影响）
  }));
  const out = { runs: 0, errors: 0, created: 0, updated: 0, skipped: 0, conflicted: 0, writeback: 0, privacy_dropped: 0 };
  for (const t of targets) {
    // 防御性再过滤：targets 亦可能来自调用方直接构造（非 loadTenantSyncTargets）→ 共用同一方向判据
    const inbound = inboundObjects(t);
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
        const engine = buildEngine({ tenantId, target: t, object: obj, provider: t.provider, trust, privacy: t.privacy || deps.privacy || null });
        const r = await engine.runOnce({ object: obj.name, tenantId, decisionId });
        out.created += r?.created || 0;
        out.updated += r?.updated || 0;
        out.skipped += r?.skipped || 0;
        out.conflicted += r?.conflicted || 0;
        out.writeback += r?.writeback || 0;
        out.privacy_dropped += r?.privacy_dropped || 0;
        if (emit) {
          emit('trace', 'sync-run-done', {
            tenant_id: tenantId, provider: t.id, object: obj.name, trust_level: t.trustLevel,
            read: r?.read || 0, created: r?.created || 0, updated: r?.updated || 0,
            skipped: r?.skipped || 0, decision_id: decisionId,
            // 隐私排除可见：否则「同步条数变少」会被读成同步故障
            privacy_dropped: r?.privacy_dropped || 0,
            ...(r?.privacy_dropped_by_reason ? { privacy_dropped_by_reason: r.privacy_dropped_by_reason } : {}),
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
  const { mappings = {}, readConfig, createResolver, pool, mintDecision, emit, callWriteback, privacy } = deps;
  const def = mappings[object];
  if (!def?.particle_type) return { ok: false, error: 'object_not_mapped' }; // fail-closed：不越权建粒子
  const extId = row.id || row.external_id || (def.identity?.external_id_field ? row[def.identity.external_id_field] : null);
  if (!extId) return { ok: false, error: 'external_id_missing' };
  const trustRow = await (readConfig || (async () => null))('sync-trust', { tenantId }).catch(() => null);
  const level = trustRow?.value?.default_level || 'L1';
  if (level === 'L1') return { ok: true, readOnly: true, externalId: extId }; // 只读观察期：事件不写库
  // P1 隐私排除（§8.1）：webhook 是与定时器并列的**第二个入口**——只在定时器路径过滤，等于
  //   「同一封被排除的邮件从 webhook 进来照样落库」。故本路径独立判定，且判定在铸决策之前（省一枚无谓决策）。
  const pf = privacy || await loadPrivacyFilter({ tenantId, readConfig });
  if (pf && !pf.isEmpty) {
    const d = pf.evaluate(signalsFromSyncRow(row));
    if (d.drop) {
      if (emit) emit('trace', 'sync-event-privacy-dropped', { tenant_id: tenantId, provider, object, reason: d.reason });
      return { ok: true, privacy_dropped: true, reason: d.reason, externalId: extId };
    }
  }
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
  // P0-1（2026-09-16）：L3 回写分支。此前本函数形参/deps 均无 callWriteback
  //   → 事件路径的 L3 永远不可达（counts.writeback 恒 0）。语义与 engine.js 的 L3 分支同源：
  //   仅 L3 回写；失败留痕（writeback_error）不静默、也不阻断读入链路（事件已入库，回写是可补偿步骤）。
  let wb = null;
  if (level === 'L3' && typeof callWriteback === 'function') {
    wb = await callWriteback({
      tenantId, object, externalId: extId, particleId: u?.particle_id, row, level, decisionId,
    }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  }
  return {
    ok: true, readOnly: false, created: !!u?.created, particle_id: u?.particle_id, decisionId,
    // 未进入回写路径（L1/L2 或未注入）时**不落这两个键**——避免把「未接线」伪造成「回写 0 条成功」
    ...(level === 'L3' && typeof callWriteback === 'function'
      ? { writeback: wb?.ok ? 1 : 0, writeback_error: wb?.ok ? null : (wb?.error || null) }
      : {}),
  };
}
