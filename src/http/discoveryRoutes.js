// src/http/discoveryRoutes.js — 线索发现只读面（候选池；租户隔离，零写零删）
// 契约（已源码级核实）：
//   · 身份解析：import { resolveMe } from './auth.js'（同步函数，返回 {ok, role, tenantId}）
//     —— 注意：req.resolveMe 全仓无挂载（非 Express 中间件），计划旧写法三态分支生产恒 403
//   · 租户隔离：scopeTenant(me)（sysadmin '*' 回退 system）；applyTenantOverride(req, me) 处理通配
//     —— 与 routes.js:521 的 /api/particles 同语义：handler 层求 tenantId 再透传给数据层
//   · icp_fit_score 是嵌套对象 {value, judge}（discoverySchema.js:35），读 .value；0 也是有效候选
//   · sources 不在 discovery payload 内（buildDiscoveryPayload 无此字段）→ 从 enrichment 六元汇总
//   · 只读端点：GET /api/discovery/candidates；无 POST / PUT / DELETE（禁 DELETE + 零写铁律）
// 结构：list 只负责取数据（返回原始 row[]，可注入替身）；投影+过滤在 handler 层执行——
//   注入式测试可直接断言「替身返回 raw row → handler 输出投影后 items」，与 configRouter 范式一致
import { Router } from 'express';
import { resolveMe as realResolveMe } from './auth.js';
import { applyTenantOverride } from './tenantScope.js';
import { queryParticles } from '../particles/particleRepo.js'; // 真实导出（particleRepo.js:176）

// 单行只读投影（无写路径）：raw particle row → 候选池展示 DTO
function projectRow(r) {
  const p = r.payload || {};
  const disc = p.discovery || {};
  const enrich = p.enrichment || {};
  // 来源徽标（C1 消费面）：enrichment 六元 source/provider 去重汇总；无富集 → []
  const sources = [...new Set(Object.values(enrich).map((v) => v?.source).filter(Boolean))];
  const providers = [...new Set(Object.values(enrich).map((v) => v?.provider).filter(Boolean))];
  return {
    account_id: r.id,
    name: disc?.name || p.name || r.name || r.slug || '',
    icp_fit_score: disc?.icp_fit_score?.value ?? null, // 嵌套对象取 .value；0 仍候选
    intent_score: disc?.intent_score?.value ?? null,
    signals: Array.isArray(disc?.signals) ? disc.signals : [],
    why_narrative: disc?.why_narrative || '',
    sources, providers, // 本体自动补全 vs 外部 adapter 徽标
    rule_ref: disc?.icp_fit_score?.judge?.rule_ref || '', // C2 glass-box 展示位
    j_score: disc?.icp_fit_score?.judge?.j_score ?? null,
  };
}

// 默认取数：只读直连候选池（真实 DB 路径；测试注入替身替换此步）
async function defaultList(me, q, tenantId) {
  const rows = await queryParticles({ type: 'CRM_ACCOUNT', tenantId, limit: Number(q.limit) || 50 });
  return rows;
}

// 候选池：投影 + 仅已评分过滤（数值 0 保留）
function toCandidates(rows) {
  return (rows || [])
    .map(projectRow)
    .filter((x) => x.icp_fit_score != null); // 仅已评分候选（0 仍然保留）
}

export function createDiscoveryRouter({ resolveMe = realResolveMe, list = defaultList } = {}) {
  const router = Router();
  const handlers = {
    candidates: async (req, res) => {
      try {
        // 真实范式：resolveMe(req) 同步返回（auth.js:57）；测试注入替身
        const me = typeof resolveMe === 'function' ? resolveMe(req) : { ok: false };
        if (!me?.ok) return res.status(403).json({ error: 'auth required' });
        const tenantId = applyTenantOverride(req, me); // 与 /api/particles 同语义（routes.js:521）
        res.json({ items: toCandidates(await list(me, req.query || {}, tenantId)) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  };
  router.get('/api/discovery/candidates', handlers.candidates);
  // 只读面：零 POST / PUT / DELETE（grep 断言依据：本文件仅一处 router.get）
  router.handlers = handlers; // 注入式测试契约（同 configRouter 范式）
  return router;
}
