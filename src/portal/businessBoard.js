// src/portal/businessBoard.js — L2C 业务闭环看板聚合端点（服务端 Router 工厂）
// 设计输入：docs/2026-08-28-business-closure-design.md §3
// 复用范式：与 agentConfig.js 一致，createXxxRouter(deps) 注入式依赖 + router.handlers 可测。
// 富化 /api/business/board：在原 grouped 基础上扩展结构化 stages + publicPool/privateLeads + total（向后兼容保留 grouped）。
// 2026-09-11 T9：原 leadPool（stage='lead'）已弃用，拆为 publicPool(S0) + privateLeads(S0P/S1)。

import { Router } from 'express';
import { resolveMe } from '../http/auth.js';
import { scopeTenant } from '../http/tenantScope.js';
import { toStageCode, isPoolStage } from '../sales/stageTaxonomy.js'; // 2026-09-11 T9：公海/私海口径拆分

// L2C 阶段定义（顺序即看板卡顺序）
const STAGES = [
  { key: 'account',   label: '客户', types: ['CRM_ACCOUNT'],          amountField: null },
  { key: 'deal',      label: '商机', types: ['CRM_DEAL'],             amountField: 'amount' },
  { key: 'quotation', label: '报价', types: ['CRM_QUOTATION'],        amountField: 'amount' },
  { key: 'contract',  label: '合同', types: ['CRM_CONTRACT'],         amountField: 'amount' },
  { key: 'order',     label: '订单', types: ['CRM_ORDER'],            amountField: 'amount' },
  { key: 'payment',   label: '回款', types: ['CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD', 'CRM_INVOICE'], amountField: 'mixed' },
];

// 被富化的粒子类型全集（供 handler 循环查询）
const BOARD_TYPES = [
  'CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_PAYMENT_PLAN',
  'CRM_PAYMENT_RECORD', 'CRM_INVOICE', 'CRM_ORDER', 'CRM_ACCOUNT',
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 单粒子金额（按类型映射，对齐设计 §3.3）
function amountOf(p) {
  const pl = p.payload || {};
  switch (p.type) {
    case 'CRM_DEAL':
    case 'CRM_QUOTATION':
    case 'CRM_CONTRACT':
    case 'CRM_ORDER':
      return num(pl.amount);
    case 'CRM_PAYMENT_PLAN':
      return num(pl.plan_amount);
    case 'CRM_PAYMENT_RECORD':
      return num(pl.paid_amount);
    case 'CRM_INVOICE':
      return num(pl.invoice_amount);
    default:
      return null;
  }
}

// 纯函数：粒子数组 → 富化 board 结构
export function buildBoard(items) {
  const list = Array.isArray(items) ? items : [];
  const grouped = {};
  for (const p of list) (grouped[p.type] ||= []).push(p);

  const stages = STAGES.map((s) => {
    const its = s.types.flatMap((t) => grouped[t] || []);
    let totalAmount = null;
    if (s.amountField === 'mixed') {
      // 回款总额 = 已回款(paid_amount) 合计；PLAN/INVOICE 不计入"已回款"
      totalAmount = its
        .filter((p) => p.type === 'CRM_PAYMENT_RECORD')
        .reduce((a, p) => a + num(p.payload?.paid_amount), 0);
    } else if (s.amountField) {
      totalAmount = its.reduce((a, p) => a + num(p.payload?.[s.amountField]), 0);
    }
    const mapped = its.map((p) => ({
      id: p.id,
      title: (p.payload && p.payload.name) || p.id || '未命名',
      amount: amountOf(p),
      stage: p.payload ? p.payload.stage : null,
      type: p.type,
    }));
    return {
      key: s.key,
      label: s.label,
      type: s.types.join(','),
      count: its.length,
      totalAmount,
      items: mapped,
    };
  });

  const deals = grouped['CRM_DEAL'] || [];
  // 2026-09-11 T9：原「线索」单列口径（stage='lead'）已随 S0/S0P 拆分失效 → 拆为公海 + 私海线索两列。
  //   公海 = stage S0（无人认领，可从公海池领取）；私海线索 = S0P（已认领待 BANT 校验）+ S1（正式线索）。
  const publicPool = {
    count: deals.filter((p) => isPoolStage(p.payload?.stage)).length,
    note: '公海=CRM_DEAL 中 stage=S0',
  };
  const privateLeads = deals.filter((p) => ['S0P', 'S1'].includes(toStageCode(p.payload?.stage))).length;
  const dealAmount = deals.reduce((a, p) => a + num(p.payload?.amount), 0);
  const contractAmount = (grouped['CRM_CONTRACT'] || []).reduce((a, p) => a + num(p.payload?.amount), 0);
  const receivedAmount = (grouped['CRM_PAYMENT_RECORD'] || []).reduce((a, p) => a + num(p.payload?.paid_amount), 0);

  return {
    stages,
    publicPool,        // 公海（S0）
    privateLeads,      // 私海线索（S0P + S1）
    total: { dealAmount, contractAmount, receivedAmount },
    grouped, // 向后兼容：/api/page/home 仍可用
  };
}

// 注入式 Router 工厂（deps.queryParticles 为统一数据源）
export function createBusinessBoardRouter(deps = {}) {
  const router = Router();
  const queryParticles = deps.queryParticles || (async () => []);

  router.get('/api/business/board', async (req, res) => {
    try {
      const me = resolveMe(req);
      const items = [];
      for (const t of BOARD_TYPES) {
        const rows = await queryParticles({ type: t, tenantId: scopeTenant(me), limit: 100 }).catch(() => []);
        items.push(...rows);
      }
      res.json(buildBoard(items));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 供测试调用
  router.handlers = { get: router.stack[router.stack.length - 1].route.stack[0].handle };
  return router;
}
