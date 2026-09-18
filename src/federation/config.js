// src/federation/config.js — 联邦关系配置（全落 config_store，零新表 / 零新 CRM_* 粒子）
// 设计：docs/2026-09-18-dealer-portal-design.md §13.1
// 纪律：所有写操作必须带 decision_id（决策第 0 闸凭证）；禁物理删除（writeConfig 用 upsert）
import { readConfig as _readConfig, writeConfig as _writeConfig } from '../config/configStore.js';

const FED_KEY = 'tenant-federation';                 // 存于 vendor_tenant（联邦主记录，唯一事实源）
const MEMBER_KEY = 'dealer-federation-membership';   // 存于 dealer_tenant（反向指针，O(1) 反查所属联邦）
const GRANT_KEY = 'shared-view-grant';               // 存于 vendor_tenant（跨租户只读授权）
const CONFLICT_KEY = 'dealer-conflict-log';          // 存于 vendor_tenant（冲突检测 append-only 日志）

// 平台级 kill-switch：feature:dealer-portal.enabled 默认 false（新租户不自动开）
export async function isFeatureOn({ readConfig = _readConfig } = {}) {
  const row = await readConfig('feature:dealer-portal', { tenantId: 'system' });
  return !!(row && row.value && row.value.enabled === true);
}

// 解析 actor 所属联邦（vendor 或 dealer 均命中）
export async function getFederation(tenantId, { readConfig = _readConfig } = {}) {
  const direct = await readConfig(FED_KEY, { tenantId });
  if (direct?.value && direct.value.vendor_tenant === tenantId) return direct.value;
  const mem = await readConfig(MEMBER_KEY, { tenantId });
  if (mem?.value?.vendor_tenant) {
    const v = await readConfig(FED_KEY, { tenantId: mem.value.vendor_tenant });
    return v?.value || null;
  }
  return null;
}

export async function createFederation(
  { vendorTenant, dealers = [], decisionId = null },
  { readConfig = _readConfig, writeConfig = _writeConfig } = {},
) {
  if (!vendorTenant) throw new Error('createFederation 缺 vendorTenant');
  if (!decisionId) throw new Error('createFederation 须经第0闸取得 decision_id（红线纪律）');
  const fed = {
    vendor_tenant: vendorTenant,
    dealers: dealers.map((d) => ({
      dealer_tenant: d.dealer_tenant,
      status: d.status || 'active',
      contract_ref: d.contract_ref || null,
      joined_at: new Date().toISOString(),
    })),
    created_at: new Date().toISOString(),
  };
  await writeConfig(FED_KEY, fed, { tenantId: vendorTenant, decisionId });
  for (const d of fed.dealers) {
    await writeConfig(MEMBER_KEY, { vendor_tenant: vendorTenant, federation_id: vendorTenant }, { tenantId: d.dealer_tenant, decisionId });
  }
  return fed;
}

export async function addDealer(
  { vendorTenant, dealerTenant, contractRef = null, decisionId = null },
  { readConfig = _readConfig, writeConfig = _writeConfig } = {},
) {
  if (!decisionId) throw new Error('addDealer 须经第0闸取得 decision_id');
  const fed = await getFederation(vendorTenant, { readConfig });
  if (!fed) throw new Error('联邦不存在，请先 createFederation');
  if (fed.dealers.find((d) => d.dealer_tenant === dealerTenant)) return fed;
  fed.dealers.push({ dealer_tenant: dealerTenant, status: 'active', contract_ref: contractRef, joined_at: new Date().toISOString() });
  await writeConfig(FED_KEY, fed, { tenantId: vendorTenant, decisionId });
  await writeConfig(MEMBER_KEY, { vendor_tenant: vendorTenant, federation_id: vendorTenant }, { tenantId: dealerTenant, decisionId });
  return fed;
}

// 双向视图授权（push: 厂商→经销商只读视图；reflow: 经销商→厂商只读聚合）
export async function grantSharedView(
  { vendorTenant, toTenant, direction, particleTypes = [], decisionId = null },
  { readConfig = _readConfig, writeConfig = _writeConfig } = {},
) {
  if (!decisionId) throw new Error('grantSharedView 须经第0闸取得 decision_id');
  if (!['push', 'reflow'].includes(direction)) throw new Error('direction 须为 push|reflow');
  const grants = (await readConfig(GRANT_KEY, { tenantId: vendorTenant }))?.value || [];
  const entry = {
    federation_id: vendorTenant,
    from_tenant: direction === 'push' ? vendorTenant : toTenant,
    to_tenant: direction === 'push' ? toTenant : vendorTenant,
    direction,
    particle_types: particleTypes,
    read_only: true,
  };
  const idx = grants.findIndex((g) => g.from_tenant === entry.from_tenant && g.to_tenant === entry.to_tenant && g.direction === direction);
  if (idx >= 0) grants[idx] = entry; else grants.push(entry);
  await writeConfig(GRANT_KEY, grants, { tenantId: vendorTenant, decisionId });
  return grants;
}

export async function listSharedViews(vendorTenant, { readConfig = _readConfig } = {}) {
  return (await readConfig(GRANT_KEY, { tenantId: vendorTenant }))?.value || [];
}

// 厂商查名下经销商列表（读 tenant-federation 聚合）
export async function listDealers(vendorTenant, { readConfig = _readConfig } = {}) {
  const fed = await getFederation(vendorTenant, { readConfig });
  if (!fed) return [];
  return (fed.dealers || []).map((d) => ({ ...d, vendor_tenant: fed.vendor_tenant }));
}

export async function addConflict(
  { vendorTenant, conflict, decisionId = null },
  { readConfig = _readConfig, writeConfig = _writeConfig } = {},
) {
  if (!conflict?.territory || !conflict?.dealer_a || !conflict?.dealer_b) {
    throw new Error('addConflict 缺 territory/dealer_a/dealer_b');
  }
  const log = (await readConfig(CONFLICT_KEY, { tenantId: vendorTenant }))?.value || [];
  const rec = { detected_at: new Date().toISOString(), status: 'open', decision_id: decisionId, ...conflict };
  log.push(rec);
  await writeConfig(CONFLICT_KEY, log, { tenantId: vendorTenant, decisionId });
  return rec;
}

export async function listConflicts(vendorTenant, { status, readConfig = _readConfig } = {}) {
  const log = (await readConfig(CONFLICT_KEY, { tenantId: vendorTenant }))?.value || [];
  return status ? log.filter((c) => c.status === status) : log;
}

export async function resolveConflict(
  { vendorTenant, detectedAt, conflictId, resolution, decisionId = null },
  { readConfig = _readConfig, writeConfig = _writeConfig } = {},
) {
  if (!decisionId) throw new Error('resolveConflict 须经第0闸取得 decision_id（HITL 仲裁）');
  const key = detectedAt || conflictId; // 冲突 ID 即 detected_at 时间戳（addConflict 生成）
  if (!key) throw new Error('resolveConflict 缺 detectedAt/conflictId');
  const log = (await readConfig(CONFLICT_KEY, { tenantId: vendorTenant }))?.value || [];
  const rec = log.find((c) => c.detected_at === key);
  if (!rec) throw new Error('冲突记录不存在');
  rec.status = 'resolved';
  rec.resolution = resolution;
  rec.resolved_at = new Date().toISOString();
  rec.decision_id = decisionId || rec.decision_id;
  await writeConfig(CONFLICT_KEY, log, { tenantId: vendorTenant, decisionId });
  return rec;
}
