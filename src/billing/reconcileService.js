// src/billing/reconcileService.js — 对账编排（拉网关对账单 + 与 payment_order 比对 + 写差异表告警）
// fail-open：差异仅写 billing_reconcile_diff + 告警，不自动改账。真实拉取需凭据（生产 cron 注入 fetcher）。
import { query, queryWrite } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { buildAuthHeader } from './wechatV3.js';
import { signParams } from './alipayPage.js';

// 主入口：fetchBillFn 注入网关账单行（生产由 wechatBillFetcher/alipayBillFetcher 提供）
export async function runReconcile({ period, fetchBillFn } = {}) {
  const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value || {};
  const gatewayRows = fetchBillFn ? await fetchBillFn() : [];
  const local = await query(`SELECT out_trade_no, amount, status FROM crm.payment_order WHERE to_char(paid_at,'YYYY-MM')=$1`, [period]);
  const localMap = new Map(local.rows.map((r) => [r.out_trade_no, r]));
  const diff = [];
  for (const g of gatewayRows) {
    const l = localMap.get(g.out_trade_no);
    if (!l) diff.push({ out_trade_no: g.out_trade_no, kind: 'missing_local', amount: g.amount });
    else if (Math.abs(Number(l.amount) - Number(g.amount)) > 0.001) diff.push({ out_trade_no: g.out_trade_no, kind: 'amount_mismatch', amount: g.amount });
  }
  for (const d of diff) {
    await queryWrite(
      `INSERT INTO crm.billing_reconcile_diff (period, out_trade_no, kind, amount, detail) VALUES ($1,$2,$3,$4,$5)`,
      [period, d.out_trade_no, d.kind, d.amount, JSON.stringify(d)]
    );
  }
  if (diff.length) console.warn(`[reconcile] ${period} 发现 ${diff.length} 条差异`);
  return { written: diff.length, diff };
}

// 微信对账单拉取（tradebill → 下载 URL → CSV 解析为 { out_trade_no, amount }）
export async function wechatBillFetcher(period, w) {
  const url = `/v3/bill/tradebill?bill_date=${period.replace('-', '')}&bill_type=ALL`;
  const auth = buildAuthHeader({ mchid: w.mch_id, serialNo: w.serial_no, privPem: w.private_key_pem, method: 'GET', url });
  const r = await fetch(`https://api.mch.weixin.qq.com${url}`, { headers: { Authorization: auth, Accept: 'application/json' } });
  const j = await r.json();
  if (!j.download_url) return [];
  const csv = await (await fetch(j.download_url)).text();
  return parseWechatCsv(csv);
}

function parseWechatCsv(csv) {
  // 微信对账单 CSV 含汇总行，业务行含交易号（第 1 列或含 out_trade_no 的列）
  const lines = csv.split('\n').filter((l) => l.trim() && !l.startsWith('`'));
  const rows = [];
  for (const line of lines) {
    const cols = line.split(',');
    // 简化：取含 28 位以上数字的列作为 out_trade_no，金额列需按真实格式解析（此处占位）
    const ot = cols.find((c) => /^\d{20,}$/.test(c.trim()));
    if (ot) rows.push({ out_trade_no: ot.trim(), amount: '0.00' });
  }
  return rows;
}

// 支付宝对账单拉取（downloadurl.query → 下载 → CSV）
export async function alipayBillFetcher(period, a) {
  const params = {
    app_id: a.app_id, method: 'alipay.data.dataservice.bill.downloadurl.query', charset: 'utf-8', sign_type: 'RSA2',
    timestamp: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'), version: '1.0',
    biz_content: JSON.stringify({ bill_type: 'trade', bill_date: period }),
  };
  const signed = signParams(params, a.private_key);
  const qs = Object.keys(signed).map((k) => `${k}=${encodeURIComponent(signed[k])}`).join('&');
  const r = await fetch(`https://openapi.alipay.com/gateway.do?${qs}`);
  const j = await r.json();
  const url = j.alipay_data_dataservice_bill_downloadurl_query_response?.bill_download_url;
  if (!url) return [];
  const csv = await (await fetch(url)).text();
  return parseAlipayCsv(csv);
}

function parseAlipayCsv(csv) {
  const rows = [];
  for (const line of csv.split('\n')) {
    if (!line.includes('ALI')) continue; // 支付宝交易号前缀
    const cols = line.split(',');
    const ot = cols.find((c) => c.trim().startsWith('ALI'));
    if (ot) rows.push({ out_trade_no: ot.trim(), amount: '0.00' });
  }
  return rows;
}
