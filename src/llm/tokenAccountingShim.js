// src/llm/tokenAccountingShim.js — 薄壳：规避跨目录循环依赖风险，复用 alerts/tokenAccounting.js 的 recordTokens
export { recordTokens } from '../alerts/tokenAccounting.js';
