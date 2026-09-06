// src/llm/embeddingClient.js — 真语义向量（SiliconFlow OpenAI 兼容 /v1/embeddings）
// 设计：docs/2026-09-03-c2c3c4-decision-integrity-implementation.md T7（embedText 的 provider='model' 分支调用本模块）。
// 维度：模型原生维度（BAAI/bge-large-zh-v1.5=1024）。本模块只产出向量，**不写库**；
//   schema 的 vector(384) 仅承载 hash 基线（默认路径），model 路径在 searchPrecedents 查询时即时重嵌候选，
//   与查询向量同源、维度一致，不与存储列冲突，故无需迁移。
// 复用：与 chat 同一份 llm_config（getDefault + hydrate 解密 api_key），不另建配置源。
import { getDefault, hydrate } from './llmConfigStore.js';
import { recordTokens } from './tokenAccountingShim.js';
// P0-1：Embedding 出口统一预检/计量（替代原 if(metering && metering.tenantId) 条件式调用）
import { enforceQuotaFor, recordUsage } from '../billing/metering.js';

// hydrate 给的 base 是 …/chat/completions；embeddings 端点同域 …/embeddings
function embeddingsUrl(base) {
  return String(base).replace(/\/chat\/completions$/, '') + '/embeddings';
}

// 取生效配置：llm_config 默认条目（hydrate 解密 api_key）；缺省/无 key → null（由 embedText 降级）
async function loadEmbedCfg() {
  try {
    const cfg = hydrate(await getDefault());
    if (!cfg || !cfg.apiKey) return null;
    return cfg;
  } catch {
    return null; // 表未建/查询失败 → 回退 hash（不阻断主流程）
  }
}

// 单条文本 → number[] 向量；失败时抛（由 embedText 捕获 → 降级为哈希签名）
// metering：{ tenantId, actor, action } 时解析 usage 回写 token_accounting（fail-open 不阻断主流程）
export async function embed(text, { model, metering } = {}) {
  const cfg = await loadEmbedCfg();
  // P0-1（2026-09-06）：预检不再因缺 metering 静默跳过——无 tenantId 时记 system + 告警（方案 B 不阻断）
  const quota = await enforceQuotaFor(metering, 'embedding');
  const meterTenantId = quota.tenantId;
  if (!cfg) throw new Error('embedding 配置不可用（llm_config 缺省条目/无 api_key）');
  // ⚠ 模型只取 embedding 专用模型：env EMBEDDING_MODEL 优先，否则 embedding 专用默认。
  //   绝不回退 cfg.model —— 那是 chat 模型（如 DeepSeek-V4-Flash），塞进 /v1/embeddings 会 400。
  //   api_key / base_url 仍来自 DB（hydrate 解密），符合「LLM 已配好、直接走 DB」的约定。
  //   默认 BAAI/bge-large-zh-v1.5：SiliconFlow 免费可用（2026-09-03 实测 200/dim=1024）；
  //   bge-small-zh-v1.5 在该账户不存在（400 Model does not exist），勿用。
  const m = model || process.env.EMBEDDING_MODEL || 'BAAI/bge-large-zh-v1.5';
  const url = embeddingsUrl(cfg.base);
  // token 安全截断：BAAI/bge-large-zh-v1.5 上限 512 token。中文约 1 字/token（含 JSON 符号），
  //   实测 ≤551 字符 200、687 字符 400。截断到 480 字符留余量，避免长 trigger_context 序列化后
  //   超 512 token 触发 400 → embedText 降级 hash（2026-09-03 生产实证：LEAD_FOLLOW_UP 候选序列化 2492 字符全降级）。
  //   截断损失尾部（多为 relations 数组），相似度靠头部 scenario_id+主字段，可接受。
  const input = String(text || '').slice(0, 480);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: m, input }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Embedding HTTP ${r.status}`);
    const j = await r.json();
    const v = j?.data?.[0]?.embedding;
    if (!Array.isArray(v) || !v.length) throw new Error('embedding 返回空向量');
    // P0-1：无条件计量（embedding 烧 prompt token；completion 无）
    await recordUsage({
      metering, source: 'embedding', action: 'embedding', usage: j?.usage || null,
      tenantId: meterTenantId,
    });
    return v.map(Number);
  } catch (e) {
    if (e?.isQuota) throw e; // quota 错误透传，不被降级吞掉
    throw new Error(`Embedding 失败: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}
