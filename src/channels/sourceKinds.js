// src/channels/sourceKinds.js — 接入形态（source kind）的**单一事实源**
// 设计：docs/2026-09-18-unified-integration-design-v2.md §5.1 / §5.4
//
// 三种接入形态（凭据归谁持有，决定「谁在承担凭据风险」）：
//   connector    凭据在对方平台 + 用户本机；用户在自己的 App 内授权，我方只经 MCP 消费结果
//   local-bridge 凭据在用户本机；本机 CLI/MCP 读取，我方不落凭据
//   direct       凭据在我方 vault（pgcrypto）；自建探针直连（**兜底**，界面必须显式声明凭据去向）
//
// ⚠ 「产品首选形态」与「API 缺省值」**不是同一个值**，混用会造成静默改语义：
//   PREFERRED_SOURCE_KIND = 'connector'：**向导界面**默认选中的卡片（设计要求的「连接器优先」，
//     用户看得见、选得到，选择是显式的）；
//   DEFAULT_SOURCE_KIND   = 'direct'   ：**接口缺省**（未声明 source_kind 时按 direct 处理），
//     理由是向后兼容：既有调用方与存量描述符都是直连语义（凭据确实进了我方 vault）。
//   若把接口缺省也设成 connector，一次既有调用就会「形态升级」为连接器并**跳过平台侧校验**——
//   而界面会显示「凭据不在我方平台」（与事实相反），且平台从未验证过连通性（假绿）。
export const SOURCE_KINDS = Object.freeze(['connector', 'local-bridge', 'direct']);

/** 向导界面默认选中的形态（连接器优先 —— 这是产品策略，落在界面上，不落在接口缺省值上）。 */
export const PREFERRED_SOURCE_KIND = 'connector';

/** 接口缺省形态：未声明 source_kind 时按 direct（向后兼容；与存量描述符语义一致）。 */
export const DEFAULT_SOURCE_KIND = 'direct';

/** 存量描述符缺字段时的回退形态（与接口缺省同一值，语义也一致：它们确实是自建直连）。 */
export const LEGACY_SOURCE_KIND = 'direct';

export const SOURCE_KIND_LABELS = Object.freeze({
  connector: '官方连接器（凭据在对方/本机）',
  'local-bridge': '本机桥接（凭据仅在你本机）',
  direct: '平台直连（凭据加密存于平台）',
});

export function isSourceKind(v) {
  return typeof v === 'string' && SOURCE_KINDS.includes(v);
}

/**
 * 取描述符的形态：合法值原样返回；缺失/非法 → LEGACY_SOURCE_KIND（**不**用新建默认值，
 *   否则存量 direct 通道会被冒充成 connector）。
 */
export function sourceKindOf(desc) {
  const v = desc?.source_kind;
  return isSourceKind(v) ? v : LEGACY_SOURCE_KIND;
}

/** 该形态的凭据是否落在我方平台（用于界面「凭据保存在哪」的**唯一**判据，禁止各页自行推断）。 */
export function credentialsOnPlatform(sourceKind) {
  return sourceKindOf({ source_kind: sourceKind }) === 'direct';
}

/** 验证记录的联合键：(channel_id, source_kind)。三形态各自独立，互不冒充。 */

/**
 * 从描述符的 `verifications` 取某个形态的验证记录。
 * 形状：{ [sourceKind]: { ok, verified_at, tool?|probe? } } —— 联合键（channel_id 由描述符本身承载，
 *   source_kind 即对象键）天然互不覆盖：写 connector 的记录不可能覆盖 local-bridge 的记录。
 */
export function verificationOf(desc, sourceKind) {
  const all = desc?.verifications;
  if (!all || typeof all !== 'object') return null;
  const rec = all[sourceKindOf({ source_kind: sourceKind })];
  return rec && typeof rec === 'object' ? rec : null;
}

/**
 * 已通过验证的形态清单。用于「同一通道只允许一个已验证形态生效」（防双写）：
 *   两个形态同时 verified ⇒ 同一批数据可能被两条通路各写一次。
 */
export function verifiedKindsOf(desc) {
  const all = desc?.verifications;
  if (!all || typeof all !== 'object') return [];
  return SOURCE_KINDS.filter((k) => all[k] && typeof all[k] === 'object' && all[k].ok !== false);
}
