// src/connectors/discovery/dedupResolver.js
// 查重条件来自配置（duplicateCriteria），不再硬编码匹配键 —— 对齐 Twenty
// build-duplicate-conditions.utils.ts:24 读 flatObjectMetadata.duplicateCriteria 的元数据驱动范式；
// 与项目「配置驱动差异化 + 阈值后台可配」铁律同构，新增对象类型只改 config、零核心改动。
// 默认来源：mergedDiscoveryRules(ctx).duplicate_criteria
//   例：{ CRM_ACCOUNT: [['external_id'],['domain'],['linkedin_url'],['name']],
//         CRM_CONTACT: [['external_id'],['email']] }
//   每组（group）内任一键命中即判重；组间为 OR（与 Twenty 语义一致）。
const MIN_STR_LEN = 2; // 短串防误判（对齐 Twenty minLengthOfStringForDuplicateCheck）

export function defaultCriteriaFor(type) {
  return type === 'CRM_CONTACT'
    ? [['external_id'], ['email']]
    : [['external_id'], ['domain'], ['linkedin_url'], ['name']]; // 可被 config 覆盖
}

// 并发兜底语义（勿改）：唯一约束冲突后**只重查赢家**，绝不重试 create（重试可能建出重复行）。
export async function resolveExistingOrCreate(type, attrs, { find, create, update, criteria }) {
  const groups = criteria ?? defaultCriteriaFor(type); // criteria 由调用方从 config 注入
  for (const group of groups) {
    for (const k of group) {
      const v = attrs[k];
      if (v == null || String(v).length <= MIN_STR_LEN) continue; // 短串跳过，防误判
      const hit = await find(type, k, v);
      if (hit) return hit; // 先查后建，预防式去重（零 DELETE）
    }
  }
  try {
    return await create(type, attrs); // 确定性外部 id 直接 upsert（createOrUpdate）
  } catch (e) {
    if (e?.code === '23505' || /unique/i.test(String(e?.message || ''))) {
      for (const group of groups) { // 并发兜底：唯一约束冲突 → 重查赢家（不重试 create）
        for (const k of group) {
          const v = attrs[k];
          if (v == null || String(v).length <= MIN_STR_LEN) continue;
          const winner = await find(type, k, v);
          if (winner) return update ? await update(winner.id, attrs) : winner;
        }
      }
    }
    throw e;
  }
}

// —— 字段级合并策略（预留设计，当前阶段不启用）——
// 项目铁律「禁 DELETE」：本阶段仅做预防式去重（命中即复用赢家，不创建重复、不删除输家）。
// 未来若需显式合并两条已存在记录，才启用以下策略（参考 Twenty
// mergeFieldValues / mergeEmails / mergePhones / mergeLinks / mergeArrayFieldValues）：
//   scalar 字段 → 优先级赢家优先；array 字段（邮箱/电话/链接）→ 去重并集。
// 启用前提：必须经决策第 0 闸 + 显式 HITL 授权（绝不自动 DELETE 输家记录）。
export const MERGE_STRATEGY_RESERVED = Object.freeze({
  scalar: 'winner-priority',
  array: 'deduped-union',
  enabled: false, // 默认关闭；违反「禁 DELETE」前不得置 true
});
