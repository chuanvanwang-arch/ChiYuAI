// src/ontology/embedding.js — 确定性哈希向量（零外部依赖，可跑全量测试）
// 生产可注入真模型（llm.ts 换 SiliconFlow embedding），向量维度须与 schema 对齐（vector(384)）
import { createHash } from 'node:crypto';

export const DIM = 384;

// 存储列维度：crm.particles.embedding 与 crm.decision.embedding 均为 vector(1024)（db/schema.sql:19,182）。
// 查询侧向量必须与此对齐才能参与 pgvector `<=>`：hash 路径产物（DIM=384）与真模型向量不在同一空间，
//   既不能混算、也不能互为排序依据（decisionRepo.js:624 实测：hash 相似度无区分度，排序≈随机取）。
// 2026-09-18 实证：assembler.js 的 L1 召回曾固定用 hashVector(q)(384) 查 vector(1024) 列 ⇒ PG 抛
//   `different vector dimensions 1024 and 384`，异常被装配层 catch 吞成 missing.L1 ⇒ L1 100% 静默失效。
export const STORED_EMBED_DIM = 1024;

// 同文本 → 同向量（确定性），无外部调用即可跑测试
export function hashVector(text) {
  const h = createHash('sha256').update(String(text || '')).digest();
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < h.length; i++) {
    const bucket = (h[i] % DIM + DIM) % DIM;
    v[bucket] += (h[i] % 251) / 251; // 有符号扰动，保留文本指纹
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function contentHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// 稳定序列化：递归按 key 排序，避免 JSONB 不保序导致同语义文本哈希漂移（决策先例检索依赖此）
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// provider 元数据：先例相似度据此决定「向量分量是否计入」。
// 背景（2026-09-03 实测）：hashVector 是 SHA-256 字节映射 384 桶的哈希签名，非语义向量 ——
//   逐字相同 cos=1.0，语义近乎同案（仅 id/金额不同）cos=0.1146，200 次微变采样过 0.6 闸仅 1 次（且与自身比）。
//   把它当语义向量用 = 向置信度注入常数噪声。故必须显式标识，供下游降级。
export const EMBED_PROVIDER = { HASH: 'hash', MODEL: 'model' };

// 统一入口：返回 { vector, provider, dim }。首期恒走 hash（接口先就绪，真模型后续接入）。
// 接入真模型时：process.env.EMBEDDING_PROVIDER='model' + src/llm/embeddingClient.js 提供 embed(text)。
export async function embedText(text, opts = {}) {
  if (process.env.EMBEDDING_PROVIDER === 'model') {
    try {
      const { embed } = await import('../llm/embeddingClient.js');
      const v = await embed(text, { metering: opts.metering });
      if (Array.isArray(v) && v.length) return { vector: v, provider: EMBED_PROVIDER.MODEL, dim: v.length };
      throw new Error('embedding 返回空向量');
    } catch (e) {
      // 降级留痕（禁静默）：明确告知本次退化为哈希签名，下游须丢弃向量分量
      const { emit } = await import('../events/bus.js');
      emit('trace', 'embedding-provider-degraded', { provider: 'model', error: String(e?.message || e) });
      // ⚠ trace 域被 memory capture 白名单阻断（capture.js BLOCKED_DOMAINS）⇒ **不落库、生产不可观测**。
      //   2026-09-18 实证：SiliconFlow 账户欠费(402) 导致本机+生产 embedding 全失效，
      //   却因「HTTP body 被吞 + trace 不落库 + recordFailure 仅内存计数」三层衰减而无人知晓。
      //   按 provenance.js:115 既有范式（"走可落库域以便留痕"）另写 monitor_event 持久面。
      try {
        const { queryWrite } = await import('../db.js');
        await queryWrite(
          `INSERT INTO crm.monitor_event (domain, event_type, payload) VALUES ('system','embedding-degraded',$1::jsonb)`,
          [JSON.stringify({
            provider: 'model',
            httpStatus: e?.httpStatus ?? null,
            providerMessage: e?.providerMessage ?? null,
            error: String(e?.message || e).slice(0, 300),
          })]
        );
      } catch { /* 观测面失败不得反噬主流程（fail-open） */ }
    }
  }
  return { vector: hashVector(text), provider: EMBED_PROVIDER.HASH, dim: DIM };
}

// PG vector 类型（node-pg 默认返回文本 '[0.1,0.2,...]'）解析为 number[]。
// 用于 searchPrecedents 优先读存储的真向量（方案 B，2026-09-03）；null/非法返回 null。
export function parsePgVector(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(Number);
  const s = String(v).trim();
  if (!s.startsWith('[')) return null;
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map(Number) : null;
  } catch {
    return null;
  }
}
