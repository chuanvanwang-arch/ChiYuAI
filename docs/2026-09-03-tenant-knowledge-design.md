# 租户级 Knowledge（领域 Know-How）设计文档

> 整理：2026-09-03 ｜ 性质：brainstorming 产物（P4 设计文档，待审查 → 批准后进 writing-plans）
> 承接：`docs/2026-09-03-lightfield-attio-gap-study.md` §1.2（P0-② 知识/背景未沉淀为租户级 Knowledge）
> 方案：已与用户澄清并获「同意」——**方案甲**：KNOWLEDGE 粒子 + 装配器按需注入 + Action 第0闸写入 + 配置页
> 设计铁律：写必经决策第 0 闸 + 零信任 HITL；禁 DELETE；阈值/类目配置化非硬编码；tenant_id 天然隔离

---

## §0 背景与定位

Lightfield「Knowledge = 结构化上下文层，Skills 运行时消费」与经验法则「反复解释同一背景 = Knowledge」指出：CRM 平台的护城河是**决策问责 + 零信任 + 行业配置化**，短板是**领域 Know-How（ICP / 竞品 / 异议 / 买家语言）未显式沉淀**。

本设计不照抄 Lightfield，而是**补齐记忆层、保留问责层**：把领域 Know-How 沉淀为租户级 KNOWLEDGE 粒子，经 Action 第 0 闸写入、装配器按需注入 Agent 上下文、复盘回路自动回写。

**关键现状修正（避免重复造轮子）**：探查源码发现 `CRM_KNOWLEDGE` 粒子类型**已注册**（particleModel.js:78-82），复盘回路 `closureLoop.js:submitRetro` 已有三通道分流框架。本设计**不做类型新增**，而是补齐「写入 Action + 注入装配 + 复盘回写 + 前端页 + 行业播种」四类桥接，成本显著低于 gap-study 原估计。

---

## §1 目标与范围

### 1.1 In Scope
1. 租户级 KNOWLEDGE 粒子的写入通道（`crm-knowledge-upsert` Action，第 0 闸 + HITL）。
2. 装配器按需注入（`assembleContext` 新增知识层，按 `intent.scenario` 过滤 kind）。
3. 复盘自动回写（赢单/输单语言 → `buyer_language` / `objections` 粒子，挂在现有 `submitRetro` C4 通道）。
4. 前端管理页 `knowledge-config.html`（租户级展示 / 录入 / 审核四类知识）。
5. 行业上线播种（扩展 `industry-onboarding` Runbook，新增 KNOWLEDGE 种子步骤）。

### 1.2 Out of Scope（本设计不触及，留待后续 brainstorming）
- P0-① 真 embedding 默认语义检索（本设计复用既有 embedding 列，但不改默认检索通道）。
- P1-⑤ 邮件/会议原始捕获（回写源上游，本设计只消费复盘结构化产出）。
- 知识向量相似检索 API（本设计走 kind 精确过滤 + 既有 embedding 列预留，语义检索单独立项）。
- 知识版本冲突合并 UI（复用既有 `merged_into` 软合并能力，不新增合并交互）。

---

## §2 现状证据盘点（file:line 验收锚点）

| 证据点 | 位置 | 结论 |
|---|---|---|
| KNOWLEDGE 类型已注册 | particleModel.js:78-82 | `slug:'knowledge'`, `identity:['term']`, `states:{registered,deprecated}`，**无 coreAttributes**（payload 自由） |
| 粒子写入 + 第 0 闸软强制 | particleRepo.js:57、:103-108、:109-116 | `createParticle(type,payload,{tenantId,actor,requireDecisionId})`；`requireDecisionId=true` 缺 decision_id 抛错；`tenant_id` 隔离落库 |
| 写时向量化 | particleRepo.js:136 `ensureAll(particle)` | 所有粒子自动写 embedding（db/schema.sql:19 `particles.embedding vector(384)+hnsw` 已就绪） |
| Action 五闸 | executor.js:49(第0闸)/:68(第1闸scope)/:84(第1.5闸RBAC)/:111(写白名单)/:119(第3闸HITL) | 写 action 经 dispatch 全闸；`needsApproval:true` 触发第3闸 |
| 装配器缺知识层 | assembler.js:108 `assembleContext`、:116-119 L1-L4、:99 `retrieveNarrative` | 现有 L1-L4 + narrative，**无 Knowledge 层**；narrative 注入形态可借鉴 |
| 复盘三通道分流 | closureLoop.js:45 `routeRetroChannels`、:95 `submitRetro`、:152-163 C3→calibration_patch | 已有 C1/C2/C3/C3′ 框架；**无知识粒子回写通道** |
| ⚠ decision 无 tenant_id | db/schema.sql:155-177 | `crm.decision` **无 tenant_id 列** → C4 回写租户须从 `involved_entities` 首实体反查粒子 tenant_id（无法取 → skip + trace 留痕，不阻断复盘） |
| 现成 write action 范式 | seed-actions.js:159-194 `crm-memory-upsert` | handler 调 `appendMemory`，可复制为 KNOWLEDGE 写入范式 |
| meta_attr 自适应登记 | metaAttrRepo.js:118 `ensureAdaptiveRegistration` | KNOWLEDGE payload 新键自动登记元模型（enabled=false/source=ai），零手动注册 |
| 行业上线播种点 | industry-onboarding/SKILL.md Step 2(tenant-profile)/Step 4(建粒子)/Step 5(账号) | KNOWLEDGE 种子可加为独立 Step，按租户 tenant_id 隔离 |

---

## §3 核心设计决策（5 项澄清结论）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 数据形态 | 复用已注册的 `CRM_KNOWLEDGE` 粒子（tenant_id 隔离 + 写时向量化），**不新增类型** |
| D2 | 类目划分 | 单类型 `KNOWLEDGE` + `payload.kind` ∈ {icp, competitors, objections, buyer_language}；identity `term` 作标题/关键词必填 |
| D3 | 写入生命周期 | Action Registry `crm-knowledge-upsert`（write）→ dispatch 五闸 + 决策第 0 闸 + HITL 确认，溯源 decision_id；复盘 C4 通道自动回写同源 |
| D4 | 注入与消费 | `assembleContext` 装配器**按需注入**（按 `intent.scenario` → kind 映射），不全量注入省 token |
| D5 | 前端 | 本轮一并做 `knowledge-config.html` 管理页（只读展示 + 录入 + 审核） |

---

## §4 数据模型

复用 `CRM_KNOWLEDGE`（particleModel.js:78-82）。`identity:['term']` 要求每条知识必带 `term`（标题/关键词）；四类由 `payload.kind` 区分。

### 4.1 payload 形态（约定，非迁移）
```jsonc
{
  "term": "XX制造-决策链",          // identity 必填，检索锚点
  "kind": "buyer_language",          // icp | competitors | objections | buyer_language
  "content": "今年要上一条产线，痛点明确……",  // 知识正文
  "source": "retro_win",             // manual | retro_win | retro_lose | email | import
  "confidence": 0.8,                 // 0-1，人工录入默认 1，复盘回写取决策 confidence
  "tags": ["产线","压价"],           // 可选检索标签
  "applies_to": "XX制造"             // 可选：客户/行业作用域提示（非强制隔离键）
}
```

### 4.2 类目语义
- `icp`：理想客户画像（行业/规模/痛点特征）——支撑 ICP_MATCH 场景。
- `competitors`：竞品定位与差异化话术——支撑报价/谈判场景。
- `objections`：常见异议与应对——支撑 REVIEW_GATE / 谈判场景。
- `buyer_language`：买家原话 / 赢单语言——支撑外呼 / 复盘场景（P1-⑥ 复利外呼前置）。

### 4.3 隔离与守恒
- 全部按 `tenant_id` 隔离（`createParticle` 落库）；admin/sysadmin 用 `tenant_id='*'` 通配查看。
- 禁 DELETE 铁律天然满足：弃用走 `state='deprecated'`（已注册状态流转），不物理删除。
- meta_attr `ensureAdaptiveRegistration` 自动登记 `kind/content/source/confidence/tags` 新键（首次写自动建元模型，零手动 seed）。

---

## §5 写入通道（crm-knowledge-upsert）

### 5.1 Action 注册（复制 crm-memory-upsert 范式，seed-actions.js:159-194）
```js
registerAction({
  name: 'crm-knowledge-upsert', kind: 'write', permission: 'auth',
  namespace: 'crm', agentTool: true, needsApproval: false, confirm: 'critical',
  // 既有范式修正（2026-09-03 实查：全仓 needsApproval:true 零先例，全部写 action 均为 false）；
  // 零信任由 第0闸（decision_id）+ action-confirm:'critical' 双段 承载（对齐 crm-deal-advance 同型）。
  rbac_roles: ['manager', 'presales', 'exec', 'sysadmin'], // 知识管理角色白名单（第1.5闸）
  version: '1.0.0', owner: 'crm-native',
  schema: { term: 'string', kind: 'string', content: 'string',
            source: 'string', confidence: 'number', tags: 'array', id: 'string' },
  parameters: {
    required: ['term', 'kind', 'content'],
    properties: {
      id: { type: 'string', description: '存在则更新，缺则新建' },
      term: { type: 'string' },
      kind: { type: 'string', enum: ['icp','competitors','objections','buyer_language'] },
      content: { type: 'string' },
      source: { type: 'string', default: 'manual' },
      confidence: { type: 'number', default: 1 },
      tags: { type: 'array' },
    },
  },
  handler: async (p, ctx) => {
    const tid = ctx.tenantId || 'system';
    const payload = { term: p.term, kind: p.kind, content: p.content,
                      source: p.source || 'manual',
                      confidence: Number(p.confidence ?? 1),
                      tags: Array.isArray(p.tags) ? p.tags : [] };
    // decision_id 由 dispatch 第0闸 mint 后透传（ctx.decision_id）
    if (p.id) {
      const r = await updateParticle(p.id, { patch: payload, requireDecisionId: ctx.decision_id });
      return { ok: true, id: r.id, updated: true };
    }
    const r = await createParticle('CRM_KNOWLEDGE', payload, {
      tenantId: tid, actor: ctx.actor, requireDecisionId: ctx.decision_id,
    });
    return { ok: true, id: r.id, created: true };
  },
});
```
**闸流向**：dispatch → 第0闸（decision_id，autoDecision 或 ctx 携带）→ 第1闸 scope → 第1.5闸 RBAC（rbac_roles 白名单）→ 第2闸写白名单 → `confirm:'critical'` 双段确认（HITL 阶段 2 接入点，executor.js:1 注明）→ handler。零信任不旁路。

### 5.2 复盘自动回写（C4 通道，挂在 submitRetro）
`closureLoop.js:submitRetro` 现有 C1/C2/C3/C3′ 四通道。新增 **C4**：复盘 `payload.knowledge_particles`（赢单语言 / 异议样本）→ `createParticle('CRM_KNOWLEDGE', …, {requireDecisionId: decisionId})`。

```js
// closureLoop.js submitRetro 内，C3′ 之后追加：
// 租户解析修正（2026-09-03 实查）：crm.decision 表无 tenant_id 列（schema.sql:155-177），
//   只能从 involved_entities 首实体反查粒子 tenant_id（无法取租户 → 跳过回写并留痕，fail-safe 不阻断复盘主提交）。
const knowledgeParticles = Array.isArray(payload.knowledge_particles) ? payload.knowledge_particles : [];
let knowledgeCount = 0;
if (knowledgeParticles.length) {
  const ents = Array.isArray(exist.rows[0]?.involved_entities) ? exist.rows[0].involved_entities : [];
  let tenantId = null;
  if (ents[0]?.id) {
    const t = await query(`SELECT tenant_id FROM crm.particles WHERE id=$1`, [ents[0].id]);
    tenantId = t.rows[0]?.tenant_id || null;
  }
  if (!tenantId) {
    emit('trace', 'knowledge-c4-skip', { decision_id: decisionId, reason: 'no_tenant_from_entities' });
  } else {
    const decisionRow = exist.rows[0];
    for (const kp of knowledgeParticles) {
      if (!kp.term || !kp.kind || !kp.content) continue;
      await createParticle('CRM_KNOWLEDGE', {
        term: kp.term, kind: kp.kind, content: kp.content,
        source: 'retro_' + (payload.outcome_type || 'win'),
        confidence: decisionRow.confidence ?? 0.7,
        tags: Array.isArray(kp.tags) ? kp.tags : [],
      }, { tenantId, actor: 'decision-agent',
           requireDecisionId: decisionId });   // 溯源 decision_id，零信任不旁路
      knowledgeCount += 1;
    }
    emit('trace', 'knowledge-c4-write', { decision_id: decisionId, count: knowledgeCount });
  }
}
```
- 类目映射：赢单 → `buyer_language`（买家原话/推进特征）；输单 → `objections`（流失异议）；场景补充 → `competitors`/`icp`。
- 此为 P1-⑥ 复利外呼的**前置**（外呼/邮件起草消费 `buyer_language`），同源实现。

---

## §6 注入通道（assembleContext 按需注入）

### 6.1 新增 retrieveL_Knowledge（assembler.js 内）
```js
async function retrieveL_Knowledge(actor, intent) {
  const kinds = SCENARIO_KNOWLEDGE_MAP[intent?.scenario] || ['icp','competitors','objections','buyer_language'];
  if (!kinds.length) return [];
  const r = await query(
    `SELECT id, payload FROM crm.particles
     WHERE type='CRM_KNOWLEDGE' AND tenant_id=$1 AND state='registered'
       AND payload->>'kind' = ANY($2::text[])
     ORDER BY (payload->>'confidence')::float DESC LIMIT 20`,
    [intent?.tenantId || 'system', kinds]
  );
  return r.rows.map((row) => ({ kind: row.payload.kind, term: row.payload.term, content: row.payload.content }));
}
```
- 装配点：`assembleContext`（assembler.js:108）在 L4 之后、`narrative` 之前调用，`layers.L_KNOWLEDGE = retrieveL_Knowledge(...)`；降级链同 L1-L4（`try/catch` 标记 missing，不阻断）。
- token 优化：仅注入 `intent.scenario` 相关 kind（按需，非全量）。

### 6.2 scenario → kind 映射表（配置化，禁硬编码于逻辑散点）
落 `config_store['knowledge-injection-map']`（tenant_id 可覆盖），出厂默认：
| scenario | 注入 kind |
|---|---|
| QUOTE_PRICING / 报价谈判 | competitors, objections |
| REVIEW_GATE | objections |
| ICP_MATCH | icp |
| WIN_RETRO / LOSE_RETRO | buyer_language, objections |
| OUTBOUND / 外呼 | buyer_language |
| 缺省 | icp, competitors, objections, buyer_language |

---

## §7 前端管理页（knowledge-config.html）

- 路径：`src/web/knowledge-config.html`（与既有 `sales-thresholds-config.html` 同范式）。
- 能力：① 租户级知识清单（按 kind 分组 tab）；② 录入/编辑表单（term/kind/content/source/confidence/tags）；③ 审核态（state registered/deprecated 切换，走 `crm-knowledge-upsert` 经第 0 闸 + HITL）；④ 只读展示供审计。
- 路由：在 `src/http/routes.js` 注册静态页 + 走既有 `crm_login` + `sysadmin`/知识管理角色守卫（对齐 platform-admin 双闸）。
- 不旁路 Action Registry：页面提交经 `actionExecutor.dispatch('crm-knowledge-upsert', …)`。

---

## §8 行业上线播种（industry-onboarding 扩展）

在 `industry-onboarding/SKILL.md` Step 4（建粒子）后新增 **Step 4.5 — 播种租户 KNOWLEDGE 种子**：
- 经 `crm-knowledge-upsert`（MCP）批量建 icp/competitors/objections/buyer_language 初始条目（行业包自带，如化工行业竞品话术）。
- 落 `tenant_id=本租户`，与 §5 方案 B（全部数据按租户自有）同向。
- 上线检查清单追加一项：「本租户 KNOWLEDGE 种子已播种（icp/competitors/objections/buyer_language 各 ≥1）」。
- 种子脚本范式同 Step 5（`db/seed/tenant-knowledge-<industry>.js`，bootstrap 旁路仅测试/引导）。

---

## §9 验收口径（L1-L4，缺 L4 不算完成）

- **L1 写入合规**：`crm-knowledge-upsert` 注册为 write action；无 decision_id 被第 0 闸拦截；非白名单角色被第 1.5 闸拦截；needsApproval 未过审批被第 3 闸拦截。
- **L2 数据守恒**：KNOWLEDGE 粒子按 tenant_id 隔离；弃用走 state='deprecated' 零 DELETE；复盘 C4 回写带 decision_id 溯源。
- **L3 注入生效**：`assembleContext` 输出含 `layers.L_KNOWLEDGE`；按 scenario 仅注入相关 kind（token 审计：非全量）；某层失败降级不阻断。
- **L4 端到端**：行业上线播种 KNOWLEDGE → 装配器注入 → 决策/外呼消费 → 复盘赢单回写 buyer_language → 下一轮外呼可检索到。回归套件全绿，无 CRM 行为回退。

---

## §10 风险与铁律坚守

| 风险 | 缓解 |
|---|---|
| 知识滥用（ Agent 自写错误知识） | 第 0 闸 + HITL + rbac_roles 白名单；复盘 C4 回写仅来自结构化产出（非自由 LLM 臆测） |
| 知识污染跨租户 | tenant_id 隔离（createParticle 落库 + 注入查询带 tenant_id） |
| 裸 catch 吞错 | 接入点（复盘 C4 / 注入）须 emit('trace') + recordFailure()，禁裸 `catch(()=>{})`（对齐禁裸 catch 铁律） |
| 阈值硬编码 | scenario→kind 映射走 config_store（§6.2），禁散点硬编码 |
| 类型爆炸 | 单 KNOWLEDGE 类型 + payload.kind，类型面只增 0（已注册），符合反 CRUD 爆炸护栏 |

---

## §11 任务拆分（每 Task 一 commit，沙箱无凭证需用户本地提交）

| Task | 内容 | 验收锚点 | 依赖 |
|---|---|---|---|
| T1 | KNOWLEDGE payload 约定 + meta_attr 种子（kind/content/source/confidence/tags 约束登记） | metaAttrRepo.js:118 自适应；零迁移 | — |
| T2 | `crm-knowledge-upsert` action 注册 + handler | seed-actions.js:159 范式；executor.js 五闸 | T1 |
| T3 | `assembleContext` 新增 retrieveL_Knowledge 按需注入 + config_store 映射 | assembler.js:108；§6.2 | — |
| T4 | `submitRetro` 新增 C4 通道（赢单/输单语言回写 KNOWLEDGE） | closureLoop.js:95；§5.2 | T1,T2 |
| T5 | `knowledge-config.html` 管理页 + routes 注册 | §7 | T2 |
| T6 | `industry-onboarding` 扩展 Step 4.5 播种 | SKILL.md Step 4 | T2 |
| T7 | 回归测试（action 注册/注入/复盘回写）+ 全绿 | §9 L1-L4 | T1-T6 |

---

## §12 待审查确认点（提请用户裁决）

1. **复盘 C4 回写是否默认开启**：建议默认开（仅消费结构化 `knowledge_particles`），避免自由 LLM 臆测写入。
2. **knowledge-config.html 审核角色**：建议 `manager/presales/exec/sysadmin`（与 crm-knowledge-upsert rbac_roles 一致）。
3. **写入确认机制**：已按实査修正为**平台既有范式** `needsApproval:false + confirm:'critical'`（全仓无 needsApproval:true 先例；crm-write skill `write_two_phase:true` 同型）——零信任由第 0 闸 + confirm 双段承载，不再引入仓库零先例的硬审批流。
4. **scenario→kind 映射出厂默认**（§6.2）是否覆盖主要场景，或需补充 scenario。
4. 本设计批准后，进入 writing-plans 产出含完整代码的实施计划（每 Task 一 commit）。
