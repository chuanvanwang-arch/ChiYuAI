# 以「客户记忆 + 可溯源的自主决策 + 越用越聪明」重构销售管理

> 状态：设计已批准（brainstorming，2026-09-04 用户「同意」），移交 writing-plans 实施。
> 范围：仅重写对外宣传页 `docs/crm-ai-native-platform-pitch.html` 与系统首页 `src/web/landing.html` 的叙事主轴（hero / 三大支柱 / 为什么选我们 / 收尾）。注册登录、5 档定价、行业适配区**保持不动**。
> 约束：外部材料，不对比任何竞争对手（Lightfield / Attio 等一律不出现）。

## 1. 设计意图

用三支柱替换原技术性三能力（客户全景洞察 / 柔性粒子数据底座 / 决策问责护城河）。新三支柱更利他、更面向客户、更可记忆，且一一对位平台已建能力：

| 新支柱 | 价值主张 | 对位平台能力（支撑注脚） |
|--------|----------|--------------------------|
| 客户记忆 | 系统替你记住每个客户的来龙去脉 | 客户 360 时间线 + 决策事件挂接（柔性粒子数据底座承载） |
| 可溯源的自主决策 | 重要决定自动留痕、可解释、可审计 | decision_id 写入闸 + C2 哈希链 + 自主决策引擎（决策问责护城河） |
| 越用越聪明 | 系统随每次交互持续进化 | 事件驱动进化 + 先例检索 + 反馈闭环 |

原技术性能力不删除，降为各支柱的一句"架构支撑"注脚。

## 2. 目标文案（两页一致）

### 2.1 HERO（替换 badge-row / h1 / lead）

- badge-row 三 tag → `客户记忆` · `可溯源的自主决策` · `越用越聪明`
- h1 → `CRM-ai-native` + 渐变副标：`记住每个客户、决策可溯源、越用越聪明的销售平台`
- lead → `不是给老 CRM 外挂 AI 插件，而是以「客户记忆 × 可溯源的自主决策 × 越用越聪明」重构销售管理。系统记住每个客户的来龙去脉，重要决定自动留痕可审计，并在每次交互中持续进化——让销售团队的经验复利沉淀，而非随人离职蒸发。`
- CTA 保持（landing：`免费注册 / 登录` + `看适合哪些行业`；pitch：`看适合哪些行业` + `收费模式设计`）

### 2.2 三大支柱（替换 `#dna` 区，三卡加 id）

- eyebrow：`平台核心能力`；h2：`三大支柱 · 重构销售管理`
- sub：`以"客户记忆 + 可溯源的自主决策 + 越用越聪明"重构销售管理。长周期、多角色、强合规 B2B 销售需要的不是更花哨的 UI，而是记得住、说得清、长本事的系统。`
- 卡一（id=`pillar-memory`）：src `支柱一 · 客户记忆`；h3 `系统替你记住每个客户的来龙去脉`
  - 客户 360 时间线：四源融合（商机 / 合同 / 决策事件 / 交互记录），按时间轴还原真实轨迹
  - 关键拍板自动挂决策事件：谁批的、依据哪版政策、参考哪次先例、真实理由
  - 跨历史回溯"为什么"，而非只记录"做了什么"
  - 销售易手不丢上下文，新人秒接老客户
  - 支撑注脚：底层由柔性粒子数据底座承载，行业字段零代码生长。
- 卡二（id=`pillar-decision`）：src `支柱二 · 可溯源的自主决策`；h3 `重要决定自动留痕、可解释、可审计`
  - 决策主轴贯穿 L1–L4：写操作必挂 decision_id，记条件 / 政策版本 / 先例 / 真实理由
  - 零信任 HITL：写通道三闸（规则层 → action-confirm → 审批流），绝无绕过闸门的写
  - 自主决策引擎：置信度 ≥ 0.8 且有先例时自主放行，高危场景强制升级人工
  - 每个决定可继承为 precedent，形成可复用的先例网络
  - 支撑注脚：底层即决策问责护城河（decision_id + C2 哈希链溯源）。
- 卡三（id=`pillar-evolve`，保留 `.moat` 高亮）：src `支柱三 · 越用越聪明`；h3 `系统随每次交互持续进化`
  - 事件驱动进化：多步任务后自动沉淀 SKILL / 修正 / 反思，避免重复踩坑
  - 先例检索：新决策自动匹配历史先例，推荐更稳的路径
  - 反馈闭环：业务结果回接决策质量，校准置信度与放行策略
  - 租户知识持续复利，行业适配零代码上线
  - 注脚：即"用得越多，决策越准"。

### 2.3 为什么选我们（替换 `#why` 区，映射到三支柱）

- h2：`长周期 B2B 销售，记住、说清、长本事是刚需`
- sub：`强合规、多角色决策、报价折扣层层审批——这些场景里，"系统记得住客户、每个决定说得清、还越用越聪明"比"AI 多聪明"更重要。`
- 卡一（src `新人秒接老客户` ← 客户记忆）：记忆可继承，客户历史决策与上下文随租户沉淀，销售离职 / 易手不丢盘。
- 卡二（src `报价折扣不再黑箱` ← 可溯源的自主决策）：破例放行全程留痕，根治"口头预算批准 ≠ 落地预算"的教训。
- 卡三（src `行业零代码接入` ← 越用越聪明 / 支撑）：元模型 + 动态属性，新行业后台配置即可上线，不污染既有架构。

### 2.4 收尾 pitch

呼应三支柱：记住客户、决策可溯源、越用越聪明——把销售团队的经验变成平台资产。

## 3. 任务分解 + 生命契约 §A（双轨）

```contract-yaml
- task: "重写 landing.html 三支柱主轴"
  agent: workbuddy-main
  skills: [ai-portal-page-generation, ai-memory-lifecycle, ai-event-driven-evolution]
  memory: [crm-ai-native]
  success: "landing.html 含 id=pillar-memory / id=pillar-decision / id=pillar-evolve 三区块，且 grep 命中'客户记忆''可溯源的自主决策''越用越聪明'；文件可被 Read 完整解析无截断；注册/登录/定价区块文本未删改"
```

```contract-yaml
- task: "同步 pitch.html 三支柱主轴"
  agent: workbuddy-main
  skills: [ai-portal-page-generation, ai-memory-lifecycle, ai-event-driven-evolution]
  memory: [crm-ai-native]
  success: "pitch.html 三大支柱文本与 landing.html 一致；5 档定价表与注册引导区块未被破坏；grep 命中'客户记忆''可溯源的自主决策''越用越聪明'"
```

```contract-yaml
- task: "落设计文档并自检契约"
  agent: workbuddy-main
  skills: [brainstorming]
  memory: [crm-ai-native]
  success: "docs/2026-09-04-sales-mgmt-three-pillars-redesign.md 存在且含 3 个 contract-yaml 块；validate-contract 结构校验 exit 0"
```

```contract-yaml
- task: "两页回归冒烟"
  agent: workbuddy-main
  skills: [ai-portal-page-generation]
  memory: [crm-ai-native]
  success: "grep 确认 /api/auth/register 与 /api/auth/login 端点引用、5 档定价表、注册表单字段在两页均存在且无破损"
```

## 4. 闭环回写

| 任务 | Agent | gap_type | observed | expected | severity |
|------|-------|----------|----------|----------|----------|
| （待实施后由 workbench 回填） | — | — | — | — | — |

> 注：本任务为页面叙事重写，无对应运行时 agent 注册表项；`validate-contract.mjs` 仅做结构校验（不含 `--registry` 跨检），agent/workbuddy-main 为执行主代理名义键。
