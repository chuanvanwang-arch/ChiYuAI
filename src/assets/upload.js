// src/assets/upload.js — 非结构化证据上传/下载路由
// 设计：docs/2026-08-31-unstructured-asset-attach-design.md §4.1
// 语义：上传 = staging，**不碰任何业务数据** → 免 confirm（不属业务写）；
//       真正的业务写是「挂接」（crm-asset-attach，见 seed-actions.js，过第0闸 + 两阶段）。
// 鉴权双源：session token（resolveMe）或 MCP token（resolveIdentity）——办公智能体用 crm_login 的 token 直调。
import { Router } from 'express';
import crypto from 'node:crypto';
import { storeBuffer, readStored } from './storage.js';
import { createParticle, getParticle } from '../particles/particleRepo.js';
import { resolveMe } from '../http/auth.js';
import { resolveIdentity } from '../mcp/auth.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { emit } from '../events/bus.js';
import { readThreshold, mergedThresholds } from '../sales/salesThresholds.js';
import { readConfig } from '../config/configStore.js';
import { query } from '../db.js';

// 业务阈值一律走 config_store['sales-thresholds']（用户 2026-08-30 铁律：禁止硬编码）
async function loadThresholds() {
  try {
    const r = await readConfig('sales-thresholds', { tenantId: 'system' });
    return mergedThresholds(r?.value || {});
  } catch {
    return mergedThresholds({});
  }
}

// 租户化（T3，P0）：上传按当前账号租户阈值取数；MCP token 路径（resolveActor tenantId='system'）保持平台默认
async function loadThresholdsFor(tenantId) {
  try {
    const r = await readConfig('sales-thresholds', { tenantId });
    return mergedThresholds(r?.value || {});
  } catch {
    return mergedThresholds({});
  }
}

function decodeHeader(v) {
  const s = String(v || '').trim();
  if (!s.includes('%')) return s;
  try { return decodeURIComponent(s); } catch { return s; }
}

// 鉴权双源：先 session，再 MCP token（零信任：无凭证一律拒绝，不降级放行）
async function resolveActor(req) {
  const me = resolveMe(req);
  if (me?.ok) return { ok: true, actor: me.username, role: me.role, tenantId: me.tenantId || 'system' };
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const id = await resolveIdentity(raw).catch(() => null);
  if (id?.actor) return { ok: true, actor: id.actor, role: id.role || 'sales', tenantId: 'system' };
  return { ok: false };
}

function readMeta(req) {
  return {
    file_name: decodeHeader(req.headers['x-file-name']),
    mime: decodeHeader(req.headers['x-file-mime']) || 'application/octet-stream',
    doc_summary: decodeHeader(req.headers['x-doc-summary']) || '',
    doc_type: decodeHeader(req.headers['x-doc-type']) || 'document',
    source: decodeHeader(req.headers['x-asset-source']) || 'upload',
  };
}

// 幂等锚点：同租户 + 同 sha256 → 既有资产直接复用（禁删铁律下用幂等替代去重删除）
async function findBySha256(sha256, tenantId) {
  const r = await query(
    `SELECT id, payload FROM crm.particles
      WHERE type='CRM_UNSTRUCTURED_ASSET' AND tenant_id=$1 AND payload->>'sha256'=$2 LIMIT 1`,
    [tenantId, sha256]
  );
  return r.rows[0] || null;
}

export function createAssetRoutes() {
  const router = Router();

  // ① 上传（staging）→ 落盘 + 建 ASSET 粒子，返回 asset_id
  router.post('/api/assets/upload', async (req, res) => {
    try {
      const a = await resolveActor(req);
      if (!a.ok) return res.status(401).json({ error: 'unauthorized' });

      const buf = req.body; // express.raw 已解析（server.js 挂载，仅本路径）
      if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty_body' });

      // 租户化（T3，P0）：上传阈值按当前账号租户读（MCP token 路径 resolveActor 已兜底 'system'）
      const th = await loadThresholdsFor(a.tenantId);
      const maxMb = Number(readThreshold(th, 'asset.max_mb', 20));
      if (buf.length > maxMb * 1024 * 1024) {
        return res.status(413).json({ error: 'file_too_large', max_mb: maxMb, size: buf.length });
      }

      const meta = readMeta(req);
      if (!meta.file_name) return res.status(400).json({ error: 'x-file-name_required' });

      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const exist = await findBySha256(sha256, a.tenantId);
      if (exist) {
        return res.json({
          ok: true, asset_id: exist.id, deduped: true, sha256,
          file_name: exist.payload?.file_name || meta.file_name, size: exist.payload?.size ?? buf.length,
        });
      }

      const stored = await storeBuffer({ buf, file_name: meta.file_name, mime: meta.mime });
      const payload = {
        type: meta.doc_type,
        file_name: meta.file_name,
        mime: meta.mime,
        size: stored.size,
        sha256: stored.sha256,
        storage: 'local',
        source: meta.source,
        rel_path: stored.rel, // 存储层实现细节（不进本体 coreAttributes），下载端点按此回吐
      };
      if (meta.doc_summary) payload.doc_summary = meta.doc_summary;

      const p = await createParticle('CRM_UNSTRUCTURED_ASSET', payload, { tenantId: a.tenantId, actor: a.actor });

      // 非阻塞留痕（对齐 routes.js agent-dispatch 先例）：上传虽免 confirm，仍入决策事件流
      await recordDecisionEvent('asset_uploaded', {
        scenario_id: 'asset-upload', actor: a.actor, asset_id: p.id, sha256: stored.sha256, file_name: meta.file_name,
      }).catch(() => {});
      emit('particle', 'asset-uploaded', { id: p.id, file_name: meta.file_name, sha256: stored.sha256, actor: a.actor });

      return res.status(200).json({
        ok: true, asset_id: p.id, file_name: meta.file_name, mime: meta.mime,
        size: stored.size, sha256: stored.sha256, actor: a.actor,
      });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  // ② 下载：按 rel_path 回吐字节流（session 或 MCP token 均可）
  router.get('/api/assets/:id/download', async (req, res) => {
    const a = await resolveActor(req);
    if (!a.ok) return res.status(401).json({ error: 'unauthorized' });
    const p = await getParticle(req.params.id);
    if (!p || p.type !== 'CRM_UNSTRUCTURED_ASSET') return res.status(404).json({ error: 'not_found' });
    try {
      const buf = readStored(p.payload?.rel_path);
      res.setHeader('Content-Type', p.payload?.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(p.payload?.file_name || 'asset')}"`);
      return res.send(buf);
    } catch {
      return res.status(404).json({ error: 'file_missing' });
    }
  });

  return router;
}
