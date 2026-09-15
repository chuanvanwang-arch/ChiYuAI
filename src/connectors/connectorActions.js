// src/connectors/connectorActions.js — 外部连接器 P0（④ 外部自动采集的落地）
// 设计输入：12 文档 §7-4（ATTIO enrichment + 工商校验）；总体设计 §4 安全红线（净化 + 参数化 + 禁删）
// 铁律：
//   1. 全部走写通道第 0 闸（autoDecision=true → 自身经决策引擎 mint decision，无决策不写）
//   2. 外部数据只落 payload 事实字段 + sourcedFrom 边（auto_weak 来源语义，relation_confidence 落边 meta）
//   3. 低置信（confidence < 0.7）→ confirm 信号（阶段 3 前台 review 入口）；绝不直接冒充人工确认
//   4. 禁删：连接器只增改，不删除粒子/边
import { registerAction } from '../action/registry.js';
import { updateParticle, createEdge } from '../particles/particleRepo.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { emit } from '../events/bus.js';

const CONNECTOR_SCENARIO = 'EXTERNAL_ENRICHMENT'; // 决策场景：外部数据自动采集（写通道第 0 闸的决策载体）

// 外部 enrichment 写客户：ATTIO 型（domains/employee_range/funding/社媒/logo）
export function seedConnectorActions() {
  registerAction({
    name: 'conn-attio-enrich-account', kind: 'write', permission: 'auth',
    namespace: 'connector', agentTool: true, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'connector-attio', version: '1.0.0',
    autoWeakEdge: true, weakPredicate: 'sourcedFrom',     // 低置信来源边语义（测试断言）
    schema: { account_id: 'string', enrichment: 'object' },
    parameters: { required: ['account_id', 'enrichment'] },
    handler: async ({ account_id, enrichment }, ctx) => {
      // 写通道第 0 闸：autoDecision → 自身 mint decision（无决策不写）
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const res = await requireDecision(
          CONNECTOR_SCENARIO,
          { connector: 'attio', account_id, enrichment_keys: Object.keys(enrichment || {}) },
          [{ type: 'CRM_ACCOUNT', id: account_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'connector-enrich', { account_id, connector: 'attio', decision_id, mode: res.mode });
      }
      // 外部字段写入（只增改事实字段，不删除）
      const r = await updateParticle(account_id, { patch: enrichment });
      // 来源语义落边：ACCOUNT --sourcedFrom--> KNOWLEDGE（auto_weak，relation_confidence 落 meta）
      if (enrichment.source_knowledge_id) {
        await createEdge('CRM_ACCOUNT', account_id, 'sourcedFrom', 'CRM_KNOWLEDGE', enrichment.source_knowledge_id, {
          edge_source: 'auto_weak',
          relation_confidence: enrichment.confidence ?? 0.5,
          provenance: 'attio-enrichment', decision_id,
        }, ctx.tenantId).catch(() => {});
      }
      return { ...r, decision_id };
    },
  });

  // 工商校验写客户：制造型企业资质核验（business_verified 落 AI 确认语义，非人工冒充）
  registerAction({
    name: 'conn-zhizao-verify-account', kind: 'write', permission: 'auth',
    namespace: 'connector', agentTool: true, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'connector-zhizao', version: '1.0.0',
    autoWeakEdge: true, weakPredicate: 'sourcedFrom',
    schema: { account_id: 'string', verification: 'object' },
    parameters: { required: ['account_id', 'verification'] },
    handler: async ({ account_id, verification }, ctx) => {
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const res = await requireDecision(
          CONNECTOR_SCENARIO,
          { connector: 'zhizao-verify', account_id, verified: verification.verified },
          [{ type: 'CRM_ACCOUNT', id: account_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'connector-verify', { account_id, connector: 'zhizao', decision_id, mode: res.mode });
      }
      // 工商校验结果 → business_verified 事实（规则+AI 确认轴，低置信需 review）
      // F18 写时校验闸：business_title 过 validateBusinessTitle（非法信用代码/缺要素拒绝）→ 防脏数据污染本体
      if (verification.business_title != null) {
        const { validateBusinessTitle } = await import('../sales/businessTitle.js');
        const v = validateBusinessTitle(verification.business_title);
        if (!v.ok) throw new Error(`工商抬头校验拒绝: ${v.errors.join('; ')}`);
      }
      const r = await updateParticle(account_id, {
        patch: {
          business_verified: verification.verified,
          business_title: verification.business_title,
        },
      });
      if (verification.source_knowledge_id) {
        await createEdge('CRM_ACCOUNT', account_id, 'sourcedFrom', 'CRM_KNOWLEDGE', verification.source_knowledge_id, {
          edge_source: 'auto_weak',
          relation_confidence: verification.confidence ?? 0.6,
          provenance: 'zhizao-verify', decision_id,
        }, ctx.tenantId).catch(() => {});
      }
      return { ...r, decision_id };
    },
  });

  // conn-tender-push：标讯连接器订阅推送（T3-11；设计 §E16：大单网订阅/推送 → tender_push 事件 → 生成 DEAL(lead)）
  // 触发：外部标讯源订阅命中 → 事件驱动（定时任务事件触发器形态）
  // 验收：① 订阅条件可配置（关键词/区域） ② 匹配自动生成线索（事件驱动） ③ 外部事件进总线（审计）
  registerAction({
    name: 'conn-tender-push', kind: 'write', permission: 'auth',
    namespace: 'connector', agentTool: true, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'connector-tender', version: '1.0.0',
    autoWeakEdge: true, weakPredicate: 'sourcedFrom',     // 标讯来源 = auto_weak 边语义
    schema: { subscription: 'object', tenders: 'array' },
    parameters: {
      required: ['subscription', 'tenders'],
      properties: {
        subscription: { type: 'object', properties: { keywords: { type: 'array' }, region: { type: 'string' } } },
        tenders: { type: 'array' },
      },
    },
    handler: async ({ subscription, tenders }, ctx) => {
      const { filterTenders, pushTenderMatches, createLeadFromTender } = await import('../connectors/tenderConnector.js');
      // ① 订阅条件可配置：filterTenders 按关键词/区域匹配
      const hits = filterTenders(subscription, tenders);
      if (!hits.length) return { matched: 0, leads: [] };
      // ③ 外部事件进总线（审计）：tender_push / TENDER_PUSHED
      pushTenderMatches(subscription, tenders, {});
      // ② 匹配 → 自动生成线索（事件驱动）：每命中生成 DEAL(lead) + sourcedFrom 边
      const leads = [];
      for (const t of hits) {
        const deal = await createLeadFromTender({ tender: t, tenantId: ctx.tenantId });
        leads.push({ deal_id: deal.id, tender_id: t.id, title: t.title });
      }
      return { matched: hits.length, leads };
    },
  });

  // conn-signal-lead-gen：强购买信号命中（融资/招聘/招投标/社媒）→ 自动生成 S0 公海线索
  // 范式：完全镜像 conn-tender-push（connectorActions.js:98-126），复用 createLeadFromTender + sourcedFrom 弱边。
  // agentTool:false → 仅由 webhook/定时器/admin 端点触发，不进 agent capabilities（免 agentSpec 闭包改动）。
  registerAction({
    name: 'conn-signal-lead-gen', kind: 'write', permission: 'auth',
    namespace: 'connector', agentTool: false, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'connector-signal', version: '1.0.0',
    autoWeakEdge: true, weakPredicate: 'sourcedFrom',
    schema: { signal_type: 'string', account_id: 'string', match: 'object' },
    parameters: { required: ['signal_type', 'account_id'] },
    handler: async ({ signal_type, account_id, match }, ctx) => {
      const createLeadFromTender = ctx.createLeadFromTender
        || (await import('../connectors/tenderConnector.js')).createLeadFromTender;
      const createEdgeFn = ctx.createEdge || createEdge;
      const deal = await createLeadFromTender({ signal: { type: signal_type, ...match }, tenantId: ctx.tenantId });
      // 溯源弱边：ACCOUNT --sourcedFrom--> DEAL（强信号来源语义）
      await createEdgeFn('CRM_ACCOUNT', account_id, 'sourcedFrom', 'CRM_DEAL', deal.id, {
        edge_source: 'auto_weak', relation_confidence: match?.confidence ?? 0.7,
        provenance: 'signal-lead-gen', decision_id: ctx.decision_id,
      }, ctx.tenantId).catch(() => {});
      await updateParticle(account_id, { patch: { last_signal_lead: { signal_type, deal_id: deal.id } } }).catch(() => {});
      return { deal_id: deal.id, account_id, signal_type };
    },
  });
}