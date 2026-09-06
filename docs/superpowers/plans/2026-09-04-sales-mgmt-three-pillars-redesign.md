# 以「客户记忆 + 可溯源的自主决策 + 越用越聪明」重构销售管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `src/web/landing.html`（系统首页）与 `docs/crm-ai-native-platform-pitch.html`（对外宣传页）的叙事主轴，由技术性三能力重构为面向客户的三支柱（客户记忆 / 可溯源的自主决策 / 越用越聪明），两页文案一致；注册登录、5 档定价、行业适配区保持不变。

**Architecture:** 纯静态 HTML 文案改写（无后端/JS 逻辑变更）。hero badge-row 与 h1/lead 改为三支柱统领；`#dna` 三大能力卡替换为带 `id=pillar-*` 的三支柱卡（原技术能力降为"支撑"注脚）；`#why` 重映射三支柱；收尾 `.pitch` 开场/适配段呼应三支柱。

**Tech Stack:** HTML（内联 CSS，无构建）；编辑用 Edit 工具精确替换；验证用 Grep + Read 解析（静态页无单元测试，以内容关键字 + 结构完整 + 功能区块未破损为通过判据）。

---

## 文件结构

- Modify: `src/web/landing.html` — hero / `#dna` / `#why` / `.pitch` 四区
- Modify: `docs/crm-ai-native-platform-pitch.html` — 同上四区（文案与 landing 一致）
- 不动：两页的 `#start` 注册登录区、`#pricing` 5 档定价、`#industry` 行业适配区、`<script>` 逻辑、footer 注册提示

---

### Task 1: landing.html HERO 改为三支柱统领

**Files:**
- Modify: `src/web/landing.html:111-118`

- [ ] **Step 1: 替换 badge-row 三 tag**

Old:
```
      <span class="tag">决策问责闭环</span>
      <span class="tag">零信任写入</span>
      <span class="tag">行业 100% 配置化</span>
```
New:
```
      <span class="tag">客户记忆</span>
      <span class="tag">可溯源的自主决策</span>
      <span class="tag">越用越聪明</span>
```

- [ ] **Step 2: 替换 h1 副标 + lead**

Old:
```
    <h1>CRM-ai-native<br><span class="g">会记录的 AI 销售平台</span></h1>
    <p class="lead">不是给老 CRM 外挂 AI 插件，而是以「粒子数据底座 × 客户全景洞察 × 决策问责闭环」重构销售管理。
    我们的底线是——<b style="color:var(--ink)">每一个重要决定都可解释、可审计、可继承为 precedent。</b></p>
```
New:
```
    <h1>CRM-ai-native<br><span class="g">记住每个客户、决策可溯源、越用越聪明的销售平台</span></h1>
    <p class="lead">不是给老 CRM 外挂 AI 插件，而是以「客户记忆 × 可溯源的自主决策 × 越用越聪明」重构销售管理。
    系统记住每个客户的来龙去脉，重要决定自动留痕可审计，并在每次交互中持续进化——让销售团队的经验复利沉淀，而非随人离职蒸发。</p>
```

- [ ] **Step 3: 验证**

Run: `grep -n "客户记忆\|可溯源的自主决策\|越用越聪明\|粒子数据底座 × 客户全景洞察" src/web/landing.html`
Expected: 前三关键词命中；旧组合「粒子数据底座 × 客户全景洞察 × 决策问责闭环」不再出现。

- [ ] **Step 4: Commit**

```bash
git add src/web/landing.html
git commit -m "refactor(landing): hero 改为三支柱统领(客户记忆/可溯源的自主决策/越用越聪明)"
```

---

### Task 2: landing.html 三大支柱区 `#dna` 替换（加 id + 支撑注脚）

**Files:**
- Modify: `src/web/landing.html:129-163`

- [ ] **Step 1: 替换 eyebrow/h2/sub + 三卡**

Old:
```
    <div class="eyebrow">平台核心能力</div>
    <h2>三大能力 · 一个平台</h2>
    <p class="sub">以"客户全景洞察 + 柔性粒子底座 + 决策问责"重构销售管理。长周期、多角色、强合规 B2B 销售需要的不是更花哨的 UI，而是能站得住脚的决策。</p>
    <div class="grid3">
      <div class="card">
        <div class="src">能力一 · 客户全景洞察</div>
        <h3>把每次交互讲清楚"为什么"</h3>
        <ul>
          <li><b>客户 360 时间线</b>：四源融合（商机 / 合同 / 决策事件 / 交互记录），按时间轴还原真实轨迹</li>
          <li>关键拍板自动挂<b>决策事件</b>：谁批的、依据哪版政策、参考哪次先例、真实理由</li>
          <li>跨历史回溯"为什么"，而非只记录"做了什么"</li>
          <li>销售易手不丢上下文，新人秒接老客户</li>
        </ul>
      </div>
      <div class="card">
        <div class="src">能力二 · 柔性粒子数据底座</div>
        <h3>行业字段零代码长出来</h3>
        <ul>
          <li>所有业务数据基于 Particle 单元，运行时动态增删实体/属性/关系</li>
          <li>Universal Context 三层语义内核：映射 / 向量检索 / 代理推理上下文</li>
          <li>图-关系混合存储：事务走 ACID 主仓，链路推理走图仓</li>
          <li>新行业零代码上线，不污染既有架构</li>
        </ul>
      </div>
      <div class="card moat">
        <div class="src">能力三 · 决策问责护城河</div>
        <h3>决策问责 + 零信任</h3>
        <ul>
          <li><b>决策主轴贯穿 L1–L4</b>：写操作必挂 decision_id，记条件/政策版本/先例/真实理由</li>
          <li><b>零信任 HITL</b>：写通道三闸（规则层 → action-confirm → 审批流），绝无绕过闸门的写</li>
          <li><b>行业 100% 配置化差异</b>：元模型 + meta_attr 动态属性，零代码适配新行业</li>
          <li><b>多租户数据各自隔离</b>：tenant_id 全表，按租户自有主数据/知识</li>
        </ul>
      </div>
    </div>
```
New:
```
    <div class="eyebrow">平台核心能力</div>
    <h2>三大支柱 · 重构销售管理</h2>
    <p class="sub">以"客户记忆 + 可溯源的自主决策 + 越用越聪明"重构销售管理。长周期、多角色、强合规 B2B 销售需要的不是更花哨的 UI，而是记得住、说得清、长本事的系统。</p>
    <div class="grid3">
      <div class="card" id="pillar-memory">
        <div class="src">支柱一 · 客户记忆</div>
        <h3>系统替你记住每个客户的来龙去脉</h3>
        <ul>
          <li><b>客户 360 时间线</b>：四源融合（商机 / 合同 / 决策事件 / 交互记录），按时间轴还原真实轨迹</li>
          <li>关键拍板自动挂<b>决策事件</b>：谁批的、依据哪版政策、参考哪次先例、真实理由</li>
          <li>跨历史回溯"为什么"，而非只记录"做了什么"</li>
          <li>销售易手不丢上下文，新人秒接老客户</li>
        </ul>
        <p style="color:var(--mut);font-size:12.5px;margin:10px 0 0;border-top:1px dashed var(--line);padding-top:9px">支撑：柔性粒子数据底座承载，行业字段零代码生长。</p>
      </div>
      <div class="card" id="pillar-decision">
        <div class="src">支柱二 · 可溯源的自主决策</div>
        <h3>重要决定自动留痕、可解释、可审计</h3>
        <ul>
          <li><b>决策主轴贯穿 L1–L4</b>：写操作必挂 decision_id，记条件 / 政策版本 / 先例 / 真实理由</li>
          <li><b>零信任 HITL</b>：写通道三闸（规则层 → action-confirm → 审批流），绝无绕过闸门的写</li>
          <li><b>自主决策引擎</b>：置信度 ≥ 0.8 且有先例时自主放行，高危场景强制升级人工</li>
          <li>每个决定可继承为 precedent，形成可复用的先例网络</li>
        </ul>
        <p style="color:var(--mut);font-size:12.5px;margin:10px 0 0;border-top:1px dashed var(--line);padding-top:9px">支撑：决策问责护城河（decision_id + C2 哈希链溯源）。</p>
      </div>
      <div class="card moat" id="pillar-evolve">
        <div class="src">支柱三 · 越用越聪明</div>
        <h3>系统随每次交互持续进化</h3>
        <ul>
          <li><b>事件驱动进化</b>：多步任务后自动沉淀 SKILL / 修正 / 反思，避免重复踩坑</li>
          <li><b>先例检索</b>：新决策自动匹配历史先例，推荐更稳的路径</li>
          <li><b>反馈闭环</b>：业务结果回接决策质量，校准置信度与放行策略</li>
          <li>租户知识持续复利，行业适配零代码上线</li>
        </ul>
        <p style="color:var(--mut);font-size:12.5px;margin:10px 0 0;border-top:1px dashed var(--line);padding-top:9px">即"用得越多，决策越准"。</p>
      </div>
    </div>
```

- [ ] **Step 2: 验证三 id 与三关键词**

Run: `grep -n "id=\"pillar-memory\"\|id=\"pillar-decision\"\|id=\"pillar-evolve\"\|支柱一\|支柱二\|支柱三" src/web/landing.html`
Expected: 三 id 与三「支柱 N」均命中；旧「能力一/能力二/能力三」不再出现。

- [ ] **Step 3: Commit**

```bash
git add src/web/landing.html
git commit -m "refactor(landing): #dna 三大能力→三支柱(带 id + 支撑注脚)"
```

---

### Task 3: landing.html `#why` 重映射三支柱（4 卡→3 卡）

**Files:**
- Modify: `src/web/landing.html:170-194`

- [ ] **Step 1: 替换 eyebrow/h2/sub + vlist 四卡为三卡**

Old:
```
    <div class="eyebrow">为什么选我们</div>
    <h2>长周期 B2B 销售，问责是刚需</h2>
    <p class="sub">强合规、多角色决策、报价折扣层层审批——这些场景里，"每个决定都说得清"比"AI 多聪明"更重要。</p>
    <div class="vlist">
      <div class="card">
        <div class="src">报价折扣不再黑箱</div>
        <h3>破例放行全程留痕</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">"折扣是谁批的、依据哪版价格政策、参考了哪次先例"——系统用书面决策链根治"口头预算批准 ≠ 落地预算"的教训。</p>
      </div>
      <div class="card">
        <div class="src">新人秒接老客户</div>
        <h3>记忆可继承</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">客户历史决策与上下文随租户沉淀，销售离职/易手不丢盘，先例网络持续复利。</p>
      </div>
      <div class="card">
        <div class="src">行业零代码接入</div>
        <h3>你的行业字段自己长出来</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">元模型 + 动态属性，新行业后台配置即可上线，不污染既有架构、不二次开发。</p>
      </div>
      <div class="card">
        <div class="src">数据各自归属</div>
        <h3>多租户强隔离</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">tenant_id 全表隔离，每租户自带主数据/知识库，企业级数据主权清晰。</p>
      </div>
    </div>
```
New:
```
    <div class="eyebrow">为什么选我们</div>
    <h2>长周期 B2B 销售，记住、说清、长本事是刚需</h2>
    <p class="sub">强合规、多角色决策、报价折扣层层审批——这些场景里，"系统记得住客户、每个决定说得清、还越用越聪明"比"AI 多聪明"更重要。</p>
    <div class="vlist">
      <div class="card">
        <div class="src">新人秒接老客户 · 客户记忆</div>
        <h3>记忆可继承</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">客户历史决策与上下文随租户沉淀，销售离职/易手不丢盘，先例网络持续复利。</p>
      </div>
      <div class="card">
        <div class="src">报价折扣不再黑箱 · 可溯源的自主决策</div>
        <h3>破例放行全程留痕</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">"折扣是谁批的、依据哪版价格政策、参考了哪次先例"——系统用书面决策链根治"口头预算批准 ≠ 落地预算"的教训。</p>
      </div>
      <div class="card">
        <div class="src">行业零代码接入 · 越用越聪明</div>
        <h3>你的行业字段自己长出来</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">元模型 + 动态属性，新行业后台配置即可上线，不污染既有架构、不二次开发，知识随使用持续复利。</p>
      </div>
    </div>
```

- [ ] **Step 2: 验证**

Run: `grep -n "记住、说清、长本事\|新人秒接老客户 · 客户记忆\|报价折扣不再黑箱 · 可溯源的自主决策\|行业零代码接入 · 越用越聪明" src/web/landing.html`
Expected: 四关键词均命中；旧「数据各自归属」卡不再出现。

- [ ] **Step 3: Commit**

```bash
git add src/web/landing.html
git commit -m "refactor(landing): #why 重映射三支柱(4卡→3卡)"
```

---

### Task 4: landing.html 收尾 `.pitch` 开场/适配呼应三支柱

**Files:**
- Modify: `src/web/landing.html:394,399`

- [ ] **Step 1: 替换开场段**

Old:
```
      <p>市面上两类"AI CRM"：一类是老系统外挂 AI 插件（数据模型没变，AI 在现实的影子上推理）；一类是只做自动摘要的速记员（capture 不是 understanding）。<b>我们是第三类——以"客户全景洞察 + 柔性粒子底座"为地基，再加一条别人都没有的底线：每个重要销售决定都可解释、可审计、可继承为 precedent。</b></p>
```
New:
```
      <p>市面上两类"AI CRM"：一类是老系统外挂 AI 插件（数据模型没变，AI 在现实的影子上推理）；一类是只做自动摘要的速记员（capture 不是 understanding）。<b>我们是第三类——以"客户记忆 + 可溯源的自主决策 + 越用越聪明"为地基：系统记得住每个客户、每个重要决定都可解释可审计、还随使用持续进化。</b></p>
```

- [ ] **Step 2: 替换适配段**

Old:
```
      <p>贵司（工业装备/医疗器械/企业软件…）销售周期长、决策角色多、报价回款需层层审批、合规审计要求高——正好命中我们的三件武器：<b>粒子柔性底座</b>（行业字段零代码长出来）、<b>决策问责闭环</b>（审批全程留痕）、<b>多租户隔离</b>（数据各自归属）。</p>
```
New:
```
      <p>贵司（工业装备/医疗器械/企业软件…）销售周期长、决策角色多、报价回款需层层审批、合规审计要求高——正好命中我们的三大支柱：<b>客户记忆</b>（来龙去脉随租户沉淀）、<b>可溯源的自主决策</b>（审批全程留痕、可审计）、<b>越用越聪明</b>（行业 Know-How 零代码长出来、知识持续复利）。</p>
```

- [ ] **Step 3: 验证**

Run: `grep -n "客户记忆 + 可溯源的自主决策 + 越用越聪明\|三大支柱：客户记忆" src/web/landing.html`
Expected: 两处均命中；旧「三件武器：粒子柔性底座」不再出现。

- [ ] **Step 4: Commit**

```bash
git add src/web/landing.html
git commit -m "refactor(landing): 收尾 pitch 呼应三支柱"
```

---

### Task 5: pitch.html HERO + `#dna` 同步（与 landing 一致）

**Files:**
- Modify: `docs/crm-ai-native-platform-pitch.html:94-100,111-145`

- [ ] **Step 1: 替换 HERO badge-row + h1/lead（同 Task 1）**

Old:
```
      <span class="tag">决策问责闭环</span>
      <span class="tag">零信任写入</span>
      <span class="tag">行业 100% 配置化</span>
```
New:
```
      <span class="tag">客户记忆</span>
      <span class="tag">可溯源的自主决策</span>
      <span class="tag">越用越聪明</span>
```
Old:
```
    <h1>CRM-ai-native<br><span class="g">会记录的 AI 销售平台</span></h1>
    <p class="lead">不是给老 CRM 外挂 AI 插件，而是以「粒子数据底座 × 客户全景洞察 × 决策问责闭环」重构销售管理。
    我们的底线是——<b style="color:var(--ink)">每一个重要决定都可解释、可审计、可继承为 precedent。</b></p>
```
New:
```
    <h1>CRM-ai-native<br><span class="g">记住每个客户、决策可溯源、越用越聪明的销售平台</span></h1>
    <p class="lead">不是给老 CRM 外挂 AI 插件，而是以「客户记忆 × 可溯源的自主决策 × 越用越聪明」重构销售管理。
    系统记住每个客户的来龙去脉，重要决定自动留痕可审计，并在每次交互中持续进化——让销售团队的经验复利沉淀，而非随人离职蒸发。</p>
```

- [ ] **Step 2: 替换 `#dna` 三卡（同 Task 2 的 New 块，含 id + 支撑注脚）**

Old（同 landing Task 2 Old；注意 pitch 此处无 id）：
```
    <div class="eyebrow">平台核心能力</div>
    <h2>三大能力 · 一个平台</h2>
    <p class="sub">以"客户全景洞察 + 柔性粒子底座 + 决策问责"重构销售管理。长周期、多角色、强合规 B2B 销售需要的不是更花哨的 UI，而是能站得住脚的决策。</p>
    <div class="grid3">
      <div class="card">
        <div class="src">能力一 · 客户全景洞察</div>
        ...
      </div>
      <div class="card">
        <div class="src">能力二 · 柔性粒子数据底座</div>
        ...
      </div>
      <div class="card moat">
        <div class="src">能力三 · 决策问责护城河</div>
        ...
      </div>
    </div>
```
New: 与 Task 2 的 New 块完全一致（含 `id="pillar-memory"` / `id="pillar-decision"` / `id="pillar-evolve"` 与三支撑注脚）。

- [ ] **Step 3: 验证**

Run: `grep -n "id=\"pillar-memory\"\|id=\"pillar-decision\"\|id=\"pillar-evolve\"\|支柱一 · 客户记忆\|支柱二 · 可溯源的自主决策\|支柱三 · 越用越聪明" docs/crm-ai-native-platform-pitch.html`
Expected: 三 id 与三「支柱 N · …」均命中。

- [ ] **Step 4: Commit**

```bash
git add docs/crm-ai-native-platform-pitch.html
git commit -m "refactor(pitch): hero + #dna 同步三支柱(与 landing 一致)"
```

---

### Task 6: pitch.html `#why` + 收尾 `.pitch` 同步

**Files:**
- Modify: `docs/crm-ai-native-platform-pitch.html:152-171,329,334`

- [ ] **Step 1: 替换 `#why` 三卡（同 Task 3 New，但容器为 `.grid3`）**

Old:
```
    <div class="eyebrow">为什么选我们</div>
    <h2>长周期 B2B 销售，问责是刚需</h2>
    <p class="sub">强合规、多角色决策、报价折扣层层审批——这些场景里，"每个决定都说得清"比"AI 多聪明"更重要。</p>
    <div class="grid3">
      <div class="card">
        <div class="src">报价折扣不再黑箱</div>
        <h3>破例放行全程留痕</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">"折扣是谁批的、依据哪版价格政策、参考了哪次先例"——系统用书面决策链根治"口头预算批准 ≠ 落地预算"的教训。</p>
      </div>
      <div class="card">
        <div class="src">新人秒接老客户</div>
        <h3>记忆可继承</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">客户历史决策与上下文随租户沉淀，销售离职/易手不丢盘，先例网络持续复利。</p>
      </div>
      <div class="card moat">
        <div class="src">行业零代码接入</div>
        <h3>你的行业字段自己长出来</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">元模型 + 动态属性，新行业后台配置即可上线，不污染既有架构、不二次开发。</p>
      </div>
    </div>
```
New（文案与 Task 3 一致，容器保留 `.grid3`）：
```
    <div class="eyebrow">为什么选我们</div>
    <h2>长周期 B2B 销售，记住、说清、长本事是刚需</h2>
    <p class="sub">强合规、多角色决策、报价折扣层层审批——这些场景里，"系统记得住客户、每个决定说得清、还越用越聪明"比"AI 多聪明"更重要。</p>
    <div class="grid3">
      <div class="card">
        <div class="src">新人秒接老客户 · 客户记忆</div>
        <h3>记忆可继承</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">客户历史决策与上下文随租户沉淀，销售离职/易手不丢盘，先例网络持续复利。</p>
      </div>
      <div class="card">
        <div class="src">报价折扣不再黑箱 · 可溯源的自主决策</div>
        <h3>破例放行全程留痕</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">"折扣是谁批的、依据哪版价格政策、参考了哪次先例"——系统用书面决策链根治"口头预算批准 ≠ 落地预算"的教训。</p>
      </div>
      <div class="card moat">
        <div class="src">行业零代码接入 · 越用越聪明</div>
        <h3>你的行业字段自己长出来</h3>
        <p style="color:var(--mut);font-size:13.5px;margin:6px 0 0">元模型 + 动态属性，新行业后台配置即可上线，不污染既有架构、不二次开发，知识随使用持续复利。</p>
      </div>
    </div>
```

- [ ] **Step 2: 替换收尾 `.pitch` 开场段（同 Task 4 Step 1）**

Old:
```
      <p>市面上两类"AI CRM"：一类是老系统外挂 AI 插件（数据模型没变，AI 在现实的影子上推理）；一类是只做自动摘要的速记员（capture 不是 understanding）。<b>我们是第三类——以"客户全景洞察 + 柔性粒子底座"为地基，再加一条别人都没有的底线：每个重要销售决定都可解释、可审计、可继承为 precedent。</b></p>
```
New:
```
      <p>市面上两类"AI CRM"：一类是老系统外挂 AI 插件（数据模型没变，AI 在现实的影子上推理）；一类是只做自动摘要的速记员（capture 不是 understanding）。<b>我们是第三类——以"客户记忆 + 可溯源的自主决策 + 越用越聪明"为地基：系统记得住每个客户、每个重要决定都可解释可审计、还随使用持续进化。</b></p>
```

- [ ] **Step 3: 替换收尾 `.pitch` 适配段（同 Task 4 Step 2）**

Old:
```
      <p>贵司（工业装备/医疗器械/企业软件…）销售周期长、决策角色多、报价回款需层层审批、合规审计要求高——正好命中我们的三件武器：<b>粒子柔性底座</b>（行业字段零代码长出来）、<b>决策问责闭环</b>（审批全程留痕）、<b>多租户隔离</b>（数据各自归属）。</p>
```
New:
```
      <p>贵司（工业装备/医疗器械/企业软件…）销售周期长、决策角色多、报价回款需层层审批、合规审计要求高——正好命中我们的三大支柱：<b>客户记忆</b>（来龙去脉随租户沉淀）、<b>可溯源的自主决策</b>（审批全程留痕、可审计）、<b>越用越聪明</b>（行业 Know-How 零代码长出来、知识持续复利）。</p>
```

- [ ] **Step 4: 验证**

Run: `grep -n "记住、说清、长本事\|客户记忆 + 可溯源的自主决策 + 越用越聪明\|三大支柱：客户记忆" docs/crm-ai-native-platform-pitch.html`
Expected: 三关键词均命中。

- [ ] **Step 5: Commit**

```bash
git add docs/crm-ai-native-platform-pitch.html
git commit -m "refactor(pitch): #why + 收尾 pitch 同步三支柱"
```

---

### Task 7: 两页回归冒烟（功能区块未破损）

**Files:**
- Verify: `src/web/landing.html`, `docs/crm-ai-native-platform-pitch.html`

- [ ] **Step 1: 确认注册/登录端点与表单字段仍在**

Run: `grep -c "api/auth/register\|api/auth/login\|companyName\|id=\"reg\"\|id=\"login\"" src/web/landing.html docs/crm-ai-native-platform-pitch.html`
Expected: 两文件计数 > 0（注册/登录区块未被误删）。

- [ ] **Step 2: 确认 5 档定价表仍在**

Run: `grep -c "免费版\|成长版\|增强版\|企业版\|本地旗舰版" src/web/landing.html docs/crm-ai-native-platform-pitch.html`
Expected: 两文件均命中（定价区未动）。

- [ ] **Step 3: 确认无竞品对比残留**

Run: `grep -in "lightfield\|attio\|对比竞品\| competitor" src/web/landing.html docs/crm-ai-native-platform-pitch.html`
Expected: 无输出（遵守"外部材料不对比竞争对手"）。

- [ ] **Step 4: 提交设计文档（与本次重构一并归档）**

```bash
git add docs/2026-09-04-sales-mgmt-three-pillars-redesign.md docs/superpowers/plans/2026-09-04-sales-mgmt-three-pillars-redesign.md
git commit -m "docs: 三支柱重构销售管理 设计文档 + 实施计划"
```

---

## 自审（Self-Review）

1. **Spec 覆盖**：hero（T1/T5）、#dna 三支柱带 id（T2/T5）、#why 映射（T3/T6）、收尾 pitch（T4/T6）、注册/定价/行业区不动（T7 回归）、不对比竞品（T7-S3）均已覆盖。
2. **Placeholder 扫描**：无 TBD/TODO；每步均含完整 old/new HTML 与 grep 验证命令。
3. **类型一致性**：三支柱文案在 landing 与 pitch 间逐字一致；id 命名 `pillar-memory/decision/evolve` 两页统一。
4. **范围纪律**：未触碰 `#start`/`#pricing`/`#industry`/`<script>`/footer；landing `#why` 由 4 卡收敛为 3 卡以对齐三支柱（设计文档 §2.3 已载明）。
