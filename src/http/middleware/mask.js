// src/http/middleware/mask.js — 出参脱敏中间件（P0② 展示层，不落库）
// 设计（docs/2026-09-05-security-hardening-design.md §3.2）：
//   - 个人字段（personal）：除 exec/sysadmin 外默认均 ***
//   - 商业字段（commercial）：仅 exec/sysadmin 可见，其余 ***
//   - 配置化：字段表来自 config_store['mask-fields']（缺省出厂下表）；
//     禁散点硬编码字段清单（阈值配置化铁律）
// 幂等：maskFields 返回浅拷贝，不改原对象（写通道不受影响，纯展示层）
const DEFAULT_MASK_FIELDS = {
  personal: ['phone_numbers', 'email_addresses', 'id_card', 'bank_account'],
  commercial: ['list_price', 'net_price', 'commission_rate', 'discount_rate', 'cost_base'],
};

const VISIBLE_COMMERCIAL_ROLES = ['exec', 'sysadmin', 'ADMIN', 'SYSADMIN'];

export function normalizeRoleForMask(role) {
  if (!role) return null;
  const r = String(role).toLowerCase();
  return VISIBLE_COMMERCIAL_ROLES.includes(r) ? r : null;
}

export function maskFields(obj, { role }, maskCfg = DEFAULT_MASK_FIELDS) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  const visibleCommercial = normalizeRoleForMask(role) != null;
  for (const [cat, fields] of Object.entries(maskCfg)) {
    if (cat === 'commercial' && visibleCommercial) continue;
    for (const f of fields) {
      if (out[f] !== undefined) out[f] = '***';
    }
  }
  return out;
}

// 中间件：拦截 res.json 做展示层脱敏；config 读取失败 → 出厂兜底（fail-safe，禁裸 catch 阻断请求）
export function createMaskMiddleware(maskConfigProvider = async () => DEFAULT_MASK_FIELDS) {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    const cfg = await maskConfigProvider().catch(() => DEFAULT_MASK_FIELDS);
    const role = req.user?.role || req.me?.role || null;
    res.json = (body) => originalJson(maskFields(body, { role }, cfg));
    next();
  };
}
