// src/llm/embeddingBootstrap.js — 真 embedding provider 的**唯一**启用判据（运行时与巡检探针共用）
//
// 为什么要抽出来（2026-09-18 实证）：
//   原逻辑内联在 src/http/server.js 启动段（NODE_ENV!=='test' 且未显式设置时，按 llm_config 是否有
//   apiKey 自动置 EMBEDDING_PROVIDER='model'）。而 KMD 探针是**独立进程**、不走该 bootstrap
//   ⇒ 探针判断"查询侧有无真向量"时看到的世界与运行时不同（判据分叉）：
//     运行时是 model、探针看到"未设置"⇒ 探针永远测不出「存储有真向量但查询侧拿不到」这类缺陷形态。
//   KMD 探针 D15（L1 消费面可达）必须与运行时同源解析，故抽成共享函数。
//
// 行为契约（与既有 server.js 内联实现一致，缺省不变）：
//   - NODE_ENV === 'test'          → 不启用（保证测试确定性、零外部依赖）
//   - 已显式设置 EMBEDDING_PROVIDER → 尊重显式值（不覆盖）
//   - llm_config 默认条目 hydrate 后有 apiKey → 置 'model'
//   - 任何异常 → 保持原状（fail-open，按 hash 降级）
//
// @returns {Promise<string|null>} 生效的 provider（未启用返回 null）
export async function ensureEmbeddingProvider(env = process.env) {
  if (env.NODE_ENV === 'test') return null;
  if (env.EMBEDDING_PROVIDER) return env.EMBEDDING_PROVIDER;
  try {
    const m = await import('./llmConfigStore.js');
    const cfg = m.hydrate(await m.getDefault());
    if (cfg && cfg.apiKey) {
      env.EMBEDDING_PROVIDER = 'model';
      return 'model';
    }
  } catch { /* 保持未启用（默认降级 hash、fail-open） */ }
  return null;
}
