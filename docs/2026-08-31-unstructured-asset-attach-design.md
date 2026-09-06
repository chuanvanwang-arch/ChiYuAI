# 设计：非结构化文档挂接管道（办公智能体上传 → CRM 粒子挂接）

> 日期：2026-08-31
> 状态：已批准（brainstorming P5 通过；三项决策 A/A/A：HTTP 直传+MCP 挂接两步 / 本地磁盘存储 / 只挂接不抽取）
> 移交：writing-plans（本文档为唯一设计输入）

## 0. 问题与结论

**问题**：CRM-ai-native 设计层完整规划了非结构化证据粒子（P9 `CRM_UNSTRUCTURED_ASSET`）与 `evidenced_by` 挂接谓词，但实现仅剩类型空壳——上传通道、挂接 Action、MCP 暴露三段管道全部缺失，办公智能体无法把文件传入平台并挂接到业务粒子。

**结论**：落地「两步管道」——① HTTP 直传（staging，非业务写，免 confirm）+ ② MCP 挂接（业务写，两阶段 + 决策第0闸 + HITL），存储走本地磁盘 + DB 元数据（`storage:'local'` 抽象前缀），本期不做内容抽取（纯文件柜 + 元数据级检索）。

## 1. 差距分析（evidence-driven）

| # | 环节 | 设计规划 | 实现现状 | 判定 |
|---|------|----------|----------|------|
| G1 | 粒子类型 | `docs/2026-08-25-01-ai-particle-system-design.md` §5（P9 承载合同附件/发票票据/会议纪要，doc_summary/doc_class aiAttrs） | `src/particles/particleModel.js:82-86` 类型已注册，无 coreAttributes | 半成品 |
| G2 | 挂接谓词 | 同上 §4 `evidenced_by`（DEAL/ACCOUNT→ASSET，auto_weak + evidence_ref） | **已在受控谓词表** `particleModel.js:265`；`data-particle-edge-create` 存在（seed-actions.js:179）但 `agentTool:false` 且被 MCP 排除 | 谓词可用，通道缺 |
| G3 | 文件存储 | 设计未明确（仅 url 字段暗示外链） | `routes.js` 无 multer/multipart——无任何上传端点 | **真缺口** |
| G4 | MCP 暴露 | §6.13 无头暴露 | `src/mcp/tools.js:65` write 循环排除 `data-*` 前缀 → `data-particle-create` 不经 MCP；无文件上传工具 | **真缺口** |
| G5 | 写时索引 | `docs/2026-08-25-02-ai-ontology-vector-build.md` 文档→分块→向量三层 | `particleRepo.js:98` `ensureAll` 只索引粒子元数据文本 | 内容层缺（本期不做） |
| G6 | 办公智能体消费面 | §6.4 Skills-as-a-Service | `plugin/skills/crm-write/SKILL.md` 两阶段写骨架就绪，清单含 `data-particle-create` 但 MCP 面不可达 | 管道断 |

## 2. 总体架构：两步管道

```
办公智能体（WorkBuddy/千问等）
  │ ① POST /api/assets/upload（multipart，MCP token / session 双源鉴权）
  ▼
本地存储 uploads/assets/<yyyy-mm>/<uuid>.<ext>  ←  sha256 去重锚点
  │ createParticle(CRM_UNSTRUCTURED_ASSET) → ensureAll（L0 向量 + FTS 免费获得）
  ▼  返回 asset_id（staging 态：uploaded）
  │ ② MCP 工具 crm-asset-attach（两阶段写）
  │    phase1: decision_id → {confirm_token, form}
  │    phase2: confirm_token → createEdge(target, 'evidenced_by', asset)
  ▼
edges 表 evidenced_by 边（meta: edge_source='manual', evidence_ref, sha256, decision_id, attached_by）
```

**闸门语义判定**：上传是 staging（只创建 ASSET 粒子自身，不碰业务数据）→ 免 confirm，决策审计经 `recordDecisionEvent` 非阻塞留痕（对齐 `routes.js:527-528` agent-dispatch 先例）；挂接是业务写 → 第0闸 + 1.5闸 RBAC + 两阶段 confirm + 禁删红线全继承。

## 3. 数据模型变更

`src/particles/particleModel.js:82-86` `CRM_UNSTRUCTURED_ASSET` 补 coreAttributes（全部 ∈ 19 类型有穷集）：

| 属性 | 类型 | 说明 |
|---|---|---|
| file_name | text | identity 字段显式声明 |
| mime | select | application/pdf 等 |
| size | number | 字节 |
| sha256 | text | 去重锚点 + 完整性校验 |
| storage | select | `local`（抽象前缀，未来 `s3` 只加 adapter） |
| doc_summary | text | 上传者一句话摘要（后续换 AI 生成） |
| source | select | upload / email / scan |

## 4. 通道与闸门详设

### 4.1 POST /api/assets/upload（multipart）

- 鉴权双源：`resolveMe(req)`（session）**或** MCP token（复用 `src/mcp/auth.js` token→actor 映射；办公智能体用 `crm_login` 拿 token 后以 `Authorization: Bearer` 或表单字段 `api_token` 直调）
- 大小上限走后台配置 `config_store['asset-upload']`（默认 20MB；阈值配置化铁律——禁硬编码）
- sha256 幂等：同 hash 已存在 → 返回既有 asset_id（禁删铁律下以幂等替代去重删除）
- 落库走 `createParticle` → `particleRepo.js:98` `ensureAll` 自动 L0 向量 + FTS
- 事件：`emit('particle','asset-uploaded', {...})`
- 配套 `GET /api/assets/:id/download`（session 或 MCP token 鉴权，流式回吐，校验 sha256）

### 4.2 Action crm-asset-attach（业务写，两阶段）

- `kind:'write'`, namespace `crm`, `agentTool:true`，**非 data- 前缀 → `tools.js:65` 写循环自动纳入 MCP 暴露，零改 tools.js**
- schema：`{ asset_id, target_type, target_id, evidence_ref? }`
- 闸门链：第0闸（gateway 校验 decision_id，scenario `evidence_attach`）→ 1.5闸 RBAC → 两阶段 confirm_token → 禁删
- handler：
  1. 校验 asset 存在且 state=uploaded
  2. 校验 target_type ∈ 白名单 {CRM_DEAL, CRM_ACCOUNT, CRM_QUOTATION, CRM_CONTRACT, CRM_INVOICE}（对齐设计 §4 evidenced_by 语义域）
  3. `createEdge(target_type, target_id, 'evidenced_by', 'CRM_UNSTRUCTURED_ASSET', asset_id, meta)`，meta = `{edge_source:'manual', evidence_ref, sha256, decision_id, attached_by: ctx.actor}`
  4. `emit('particle','asset-attached', {...})`
- 输出纪律：回显业务语言摘要（「已将《XX合同.pdf》挂接到商机 Y」+ sha256 前 8 位 + decision_id）；失败回显业务语言原因

## 5. 消费面更新

| 位置 | 变更 |
|---|---|
| `src/agent/agentSpec.js` followup-agent | actions/skillCalls 增 `crm-asset-attach`（保持 skillCalls ⊆ actions 闭包） |
| `plugin/skills/crm-write/SKILL.md` | 写清单增行 + 新增「资产挂接两步编排」章节（办公智能体消费契约：先 HTTP 上传拿 asset_id，再 MCP 两阶段挂接） |

## 6. 任务与生命契约（双轨）

```contract-yaml
- task: "T1 存储适配层 src/assets/storage.js"
  agent: followup-agent
  skills: [data-particle-create]
  memory: [followup-agent]
  success: "store() 写入 uploads/assets/<ym>/<uuid>.<ext> 并返回 {path,sha256,size,mime}；同 sha256 二次上传幂等返回同一 path"
- task: "T2 HTTP 上传/下载端点"
  agent: followup-agent
  skills: [data-particle-create]
  memory: [followup-agent]
  success: "携带 MCP token POST /api/assets/upload 返回 200+asset_id，particles 表出现 CRM_UNSTRUCTURED_ASSET 行且 payload.sha256 非空；GET /api/assets/:id/download 回吐字节流一致"
- task: "T3 crm-asset-attach Action + agentSpec 扩展"
  agent: followup-agent
  skills: [data-particle-create]
  memory: [followup-agent]
  success: "经 gateway 两阶段后 edges 表出现 evidenced_by 边且 meta.decision_id 非空；装配断言 skillCalls⊆actions 全绿"
- task: "T4 MCP 暴露冒烟"
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  success: "listMcpTools() 含 crm-asset-attach；无 decision_id 调用被拒（第0闸真拦截）"
- task: "T5 插件 SKILL 消费契约更新 + 测试"
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  success: "plugin/skills/crm-write 写清单含 crm-asset-attach；vitest 新增用例全绿（含 sha256 幂等/闸门拒绝/白名单外目标类型拒绝）"
```

**契约说明（散文轨）**：五任务均由 `followup-agent` 承接（其 actions 已含 data-particle-create/data-particle-edge-create，扩展最小）；契约 `skills` 取**当前** `skillCalls` 已有项（静态校验锚点）——`crm-asset-attach` 在 T3 完成注册表扩展后，运行态监控自动按新 skillCalls 清单追踪其真实调用；成功标准均为可验证判定式（DB 行存在/边存在/工具清单含名/闸门真拦截）。

## 7. 明确不做（YAGNI）

- 内容抽取与文本级 RAG（txt/md 抽取、pdf/docx 解析、chunk 向量三层）→ 后续独立迭代「B 阶段」
- 对象存储 adapter（storage 字段已留抽象前缀）
- 超期/孤儿资产治理（staging 资产长期未挂接的回收策略）
- 以上留 TODO 注释锚点，不进本期

## 8. 规格自检（P7）

- [x] 占位符：无
- [x] 矛盾：上传「免 confirm」vs 写闸——已在 §2 判定块说明语义边界（staging 非业务写）
- [x] 歧义：谓词白名单已核实存在（`particleModel.js:265`），非缺口
- [x] 范围：五任务闭环，无范围蔓延
- [x] 契约有效性：`node scripts/validate-contract.mjs docs/2026-08-31-unstructured-asset-attach-design.md --registry src/agent/agentSpec.js` 通过（见执行记录）
- [x] 铁律核对：无 DELETE 语义（幂等替代去重）；阈值走 config_store；UI 无涉（无页面改动）；每 Task 一 commit

## 9. 闭环回写（workbench 监控 → 反馈吸收）

| task | 监控点 | gap_type 候选 |
|---|---|---|
| T1-T5 | agent 是否真调声明 skills / 读声明 memory / success 判定 | skill / memory / success |

反馈写入 `docs/2026-08-31-unstructured-asset-attach-design.md.feedback.json`；同 (task, gap_type) 复发 ≥2 次 → SKILL 改进提案（需用户批准）。

## 10. 移交

下一步唯一入口：writing-plans，任务继承本文 §6 契约。
