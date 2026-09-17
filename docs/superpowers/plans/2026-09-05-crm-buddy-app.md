# CRM 销售智能工作台 · Buddy 应用实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CRM-ai-native 交付一个对标腾讯电子签 AI 合同助手的 WorkBuddy Buddy 应用——一层"编排 + 门户外壳"，全部复用现有页面/Skill/专家/连接器/组件，零新增业务逻辑。

**Architecture:** 单一门户外壳 `buddy-crm-portal.html`（复用 `/portal/components.js` 设计系统）承载 6 个主 Tab，每个 Tab 用 `crm-button` 胶囊切换主区 `<iframe>` 到既有 `src/web/*.html` 页面，底部对话区 `<iframe>` 复用既有 `agent-workbench.html`；另交付开放平台 5 模块 manifest（全量引用现有资产）与规范素材。

**Tech Stack:** 纯静态 HTML + `/portal` 设计系统（tokens.css/common.css/components.js）；SVG 素材；JSON manifest。无后端改动，无新业务逻辑。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/web/buddy-crm-portal.html` | 新建 | 门户外壳：6 Tab 导航 + 主区 iframe（切换既有页面）+ 底部对话区 iframe（复用 agent-workbench） |
| `buddy-crm-manifest.json` | 新建 | 开放平台 5 模块配置，全量引用现有专家/Skill/连接器/页面，无新建能力 |
| `assets/app-icon.svg` | 新建 | 16px 应用 icon（线宽 1.2px、带断口、圆角 100%） |
| `assets/hero-day.svg` | 新建 | 专家页精选场景背景图-日间（1000×910，底图+3层渐变蒙层） |
| `assets/hero-night.svg` | 新建 | 专家页精选场景背景图-夜间（1000×910） |

约束：所有页面必须遵守 `docs/specs/2026-09-05-ui-authoring-rules.md`（R1–R7），用 `scripts/new-page.mjs` 脚手架生成骨架，提交前跑 `node scripts/ui-lint.mjs`。

---

## Task 1: 门户外壳 `buddy-crm-portal.html`

**Files:**
- Create: `src/web/buddy-crm-portal.html`（经脚手架生成后编辑）

- [ ] **Step 1: 用脚手架生成合规骨架**

Run:
```bash
cd /d/system/CRM-ai-native
node scripts/new-page.mjs buddy-crm-portal --title "CRM 销售智能工作台"
```
Expected: 输出 `✅ 已生成 src/web/buddy-crm-portal.html（通过 ui-lint --strict）`。

- [ ] **Step 2: 用下方完整内容覆盖骨架 body 与 style**

打开 `src/web/buddy-crm-portal.html`，将脚手架生成的 `<style>` 与 `<body>` 整体替换为下方内容（`<head>` 三件套保留不动）。

`<!-- 私有样式：仅用带页面前缀的类，绝不重声明设计系统保留类 -->`
```html
<style>
  .buddy-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
  .buddy-tab[active="true"] { background: var(--ac); color: #fff; }
  .buddy-bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
  .buddy-caps { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 12px; }
  .buddy-frame { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .buddy-view { height: 62vh; }
  .buddy-chat { height: 38vh; }
  .buddy-err { color: var(--err); font-size: 12px; margin-bottom: 8px; }
</style>
```

`<body>` 内容（替换脚手架的 header/page-sub/bar/list/script）：
```html
<header class="page-head"><div class="ph-main"><h1 class="page-title">CRM 销售智能工作台</h1></div></header>
<div class="page-sub">企业AI销售决策平台垂直工作台：客户洞察、商机推进、报价折扣、决策审批、业绩治理、平台管理，一键直达既有能力。</div>

<div class="buddy-err" id="buddy-err"></div>

<!-- 主 Tab 导航：6 个 crm-button（满足 R4 禁止裸 button） -->
<nav class="buddy-tabs">
  <crm-button class="buddy-tab" data-tab="客户洞察" active="true">客户洞察</crm-button>
  <crm-button class="buddy-tab" data-tab="商机推进">商机推进</crm-button>
  <crm-button class="buddy-tab" data-tab="报价折扣">报价折扣</crm-button>
  <crm-button class="buddy-tab" data-tab="决策审批">决策审批</crm-button>
  <crm-button class="buddy-tab" data-tab="业绩治理">业绩治理</crm-button>
  <crm-button class="buddy-tab" data-tab="平台管理">平台管理</crm-button>
</nav>

<!-- 当前 Tab 的子页面胶囊：切换主区 iframe -->
<div class="buddy-caps" id="buddy-caps"></div>

<!-- 主区：iframe 复用既有页面（零新建业务逻辑） -->
<iframe class="buddy-frame buddy-view" id="buddy-view" src="/portal/account-360.html" title="业务视图"></iframe>

<!-- 对话区：iframe 复用既有 agent-workbench -->
<iframe class="buddy-frame buddy-chat" id="buddy-chat" src="/portal/agent-workbench.html" title="AI 对话"></iframe>

<script type="module">
  // 每个主 Tab → 一组既有页面；全部复用 src/web/*.html，无新建
  const PAGES = {
    "客户洞察": ["account-360.html","named-accounts.html","named-account-targets.html"],
    "商机推进": ["pipeline.html","kanban.html","deal-detail.html","funnel-quality.html"],
    "报价折扣": ["quotation-detail.html","offer-policy.html","price-list.html","product-catalog.html"],
    "决策审批": ["approval-flow.html","decision-graph.html","decision-thinking.html","approval-config.html"],
    "业绩治理": ["sales-decision-monitor.html","business-board.html","seven-dim.html","agent-dashboard.html"],
    "平台管理": ["rbac.html","billing.html","skill-registry-board.html","tenant-management.html"]
  };
  const PAGE_BASE = "/portal/";
  const view = document.getElementById('buddy-view');
  const caps = document.getElementById('buddy-caps');
  const err = document.getElementById('buddy-err');

  function renderCaps(tab) {
    const list = PAGES[tab] || [];
    caps.innerHTML = '';
    list.forEach((p, i) => {
      const b = document.createElement('crm-button');
      b.className = 'buddy-cap';
      b.textContent = p.replace('.html','');
      if (i === 0) b.setAttribute('active','true');
      b.addEventListener('click', () => {
        view.src = PAGE_BASE + p;
        caps.querySelectorAll('crm-button').forEach(x => x.removeAttribute('active'));
        b.setAttribute('active','true');
      });
      caps.appendChild(b);
    });
  }

  document.querySelectorAll('.buddy-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.buddy-tab').forEach(x => x.removeAttribute('active'));
      t.setAttribute('active','true');
      const tab = t.getAttribute('data-tab');
      renderCaps(tab);
      const first = (PAGES[tab] || [])[0];
      if (first) view.src = PAGE_BASE + first;
    });
  });

  try {
    renderCaps("客户洞察");
  } catch (e) {
    err.textContent = '初始化失败：' + (e?.message || e);
  }
</script>
```

- [ ] **Step 3: 跑 ui-lint 验证**

Run:
```bash
cd /d/system/CRM-ai-native
node scripts/ui-lint.mjs
```
Expected: 无 `buddy-crm-portal.html:` 开头的错误/警告（存量其他页面警告可忽略）。

- [ ] **Step 4: 本地起服务验证外壳可加载**

Run（后台）:
```bash
cd /d/system/CRM-ai-native
node -e "const http=require('http'),fs=require('fs'),path=require('path');const root='src/web';http.createServer((req,res)=>{let f=path.join(root,req.url==='/'?'index.html':req.url.split('?')[0]);fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end('404')}else{res.writeHead(200);res.end(d)}})}).listen(4173,()=>console.log('on 4173'))"
```
Run:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:4173/buddy-crm-portal.html
curl -s -o /dev/null -w "%{http_code}" http://localhost:4173/account-360.html
```
Expected: 两者均返回 `200`。

- [ ] **Step 5: 提交**

```bash
git add src/web/buddy-crm-portal.html
git commit -m "feat(buddy): 新增 CRM 销售智能工作台门户外壳（复用既有页面与组件）"
```

---

## Task 2: Buddy manifest `buddy-crm-manifest.json`

**Files:**
- Create: `buddy-crm-manifest.json`

- [ ] **Step 1: 写入全量复用现有资产的 manifest**

创建 `buddy-crm-manifest.json`，内容如下（全部引用现有专家/Skill/连接器/页面，无新建能力）：

```json
{
  "app": {
    "appId": "<开放平台自动生成>",
    "name": "CRM 销售智能工作台",
    "intro": "企业AI销售决策平台垂直工作台：客户洞察、商机推进、报价折扣、决策审批、业绩治理、平台管理，一键直达既有能力。",
    "icon": "assets/app-icon.svg",
    "oauth": { "scopes": [], "callback": "", "origins": ["localhost:3000"] }
  },
  "home": {
    "slogan": "你的企业AI销售决策平台伙伴，打开即进入行业专属工作台",
    "workModes": [
      {
        "id": "sales",
        "name": "销售智能坐席",
        "systemPrompt": "你是 CRM 销售智能工作台 AI，遵循 DSM 销售方法论与 K-M-D 决策架构；写操作必须走确认/审批闸门；报价必须走 CRM_APPROVAL_FLOW；off-system 私下报价红线必须主动提醒。",
        "skills": ["crm-native", "crm-query", "crm-risk"]
      }
    ],
    "capsules": {
      "客户洞察": [
        { "label": "360 视图", "action": "crm-account-360" },
        { "label": "重点客户", "action": "named-accounts" },
        { "label": "客户调研", "action": "crm-query" },
        { "label": "客户任务线", "action": "timeline-source" }
      ],
      "商机推进": [
        { "label": "管道看板", "action": "pipeline" },
        { "label": "阶段评估", "action": "method-stage-progression" },
        { "label": "漏斗分类", "action": "method-funnel-classification" },
        { "label": "商机复盘", "action": "decision-retrospective" }
      ],
      "报价折扣": [
        { "label": "报价生成", "action": "crm-quote-create" },
        { "label": "折扣策略", "action": "offer-policy" },
        { "label": "价目表", "action": "price-list" },
        { "label": "折扣审批", "action": "crm-approval-start" }
      ],
      "决策审批": [
        { "label": "审批流", "action": "approval-flow" },
        { "label": "复核闸门", "action": "review-gate" },
        { "label": "决策追溯", "action": "crm_decision_trace" },
        { "label": "根因分析", "action": "crm_decision_root_cause" }
      ],
      "业绩治理": [
        { "label": "销售监控", "action": "sales-decision-monitor" },
        { "label": "决策监控", "action": "decision-graph" },
        { "label": "校准指标", "action": "crm_calibration_metrics" },
        { "label": "团队看板", "action": "kanban" }
      ],
      "平台管理": [
        { "label": "行业上线", "action": "industry-onboarding" },
        { "label": "RBAC", "action": "user-rbac-admin" },
        { "label": "计费套餐", "action": "billing" },
        { "label": "技能开关", "action": "skill-registry" }
      ]
    },
    "connectors": ["crm-native-mcp"]
  },
  "market": {
    "experts": ["CRM 决策专家", "DSM 销售方法论专家"],
    "skills": [
      "crm-native", "crm-query", "crm-risk",
      "method-stage-progression", "method-funnel-classification",
      "method-bant", "method-meddicc", "review-gate", "quote-engine",
      "decision-retrospective"
    ],
    "connectors": ["crm-native-mcp"],
    "cases": ["报价审批红线", "B 新能源口头预算教训"]
  },
  "others": {
    "skipBind": false,
    "bindText": "绑定后，即可获取 CRM 销售智能工作台专业能力",
    "placeholder": {
      "zh": "试试：查看客户 360 视图、推进商机、生成报价，或咨询销售决策",
      "en": "Try: view customer 360, advance a deal, generate a quote, or ask sales decisions"
    },
    "models": { "default": "deepseek-v3.1", "pool": ["deepseek-v3.1"] }
  },
  "preview": { "url": "" }
}
```

- [ ] **Step 2: JSON 合法性校验**

Run:
```bash
cd /d/system/CRM-ai-native
node -e "JSON.parse(require('fs').readFileSync('buddy-crm-manifest.json','utf8'));console.log('JSON OK')"
```
Expected: 输出 `JSON OK`。

- [ ] **Step 3: 提交**

```bash
git add buddy-crm-manifest.json
git commit -m "feat(buddy): 新增 Buddy 应用 manifest（全量复用现有专家/Skill/连接器）"
```

---

## Task 3: 规范素材（icon + 背景图）

**Files:**
- Create: `assets/app-icon.svg`
- Create: `assets/hero-day.svg`
- Create: `assets/hero-night.svg`

- [ ] **Step 1: 写应用 icon（16×16 视口，线宽 1.2，带断口，圆角 100%）**

创建 `assets/app-icon.svg`：
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <rect x="1.5" y="1.5" width="13" height="13" rx="8" fill="none" stroke="#185FA5" stroke-width="1.2" stroke-dasharray="2 1.1"/>
  <circle cx="8" cy="8" r="2.4" fill="#185FA5"/>
</svg>
```

- [ ] **Step 2: 写日间背景图（1000×910，底图+3层渐变蒙层）**

创建 `assets/hero-day.svg`：
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 910" width="1000" height="910">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E6F1FB" stop-opacity="0.0"/><stop offset="1" stop-color="#E6F1FB" stop-opacity="0.55"/></linearGradient>
    <linearGradient id="g2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B5D4F4" stop-opacity="0.35"/><stop offset="1" stop-color="#B5D4F4" stop-opacity="0.0"/></linearGradient>
    <linearGradient id="g3" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#042C53" stop-opacity="0.25"/><stop offset="1" stop-color="#042C53" stop-opacity="0.0"/></linearGradient>
  </defs>
  <rect width="1000" height="910" fill="#F8FAFC"/>
  <rect width="1000" height="910" fill="url(#g1)"/>
  <rect width="1000" height="910" fill="url(#g2)"/>
  <rect width="1000" height="910" fill="url(#g3)"/>
</svg>
```

- [ ] **Step 3: 写夜间背景图（1000×910）**

创建 `assets/hero-night.svg`（同结构，底色深、蒙层亮）：
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 910" width="1000" height="910">
  <defs>
    <linearGradient id="n1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0C447C" stop-opacity="0.0"/><stop offset="1" stop-color="#0C447C" stop-opacity="0.6"/></linearGradient>
    <linearGradient id="n2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#378ADD" stop-opacity="0.4"/><stop offset="1" stop-color="#378ADD" stop-opacity="0.0"/></linearGradient>
    <linearGradient id="n3" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E6F1FB" stop-opacity="0.25"/><stop offset="1" stop-color="#E6F1FB" stop-opacity="0.0"/></linearGradient>
  </defs>
  <rect width="1000" height="910" fill="#042C53"/>
  <rect width="1000" height="910" fill="url(#n1)"/>
  <rect width="1000" height="910" fill="url(#n2)"/>
  <rect width="1000" height="910" fill="url(#n3)"/>
</svg>
```

- [ ] **Step 4: 校验三个 SVG 均为合法 XML**

Run:
```bash
cd /d/system/CRM-ai-native
for f in assets/app-icon.svg assets/hero-day.svg assets/hero-night.svg; do node -e "const s=require('fs').readFileSync('$f','utf8');if(!s.startsWith('<svg'))throw new Error('bad');console.log('$f OK')"; done
```
Expected: 三行 `XXX OK`。

- [ ] **Step 5: 提交**

```bash
git add assets/app-icon.svg assets/hero-day.svg assets/hero-night.svg
git commit -m "feat(buddy): 新增应用 icon 与精选场景背景图（日/夜，符合规范）"
```

---

## 自检（Self-Review）

1. **Spec 覆盖**：§3 6-Tab → Task1 PAGES；§4 胶囊→Action 映射 → Task2 capsules；§5 三新增文件 → Task1/2/3 全覆盖；复用原则 → 全程未新建业务逻辑。
2. **占位符扫描**：无 TBD/TODO；所有代码块为完整可用内容。
3. **一致性**：`PAGE_BASE="/portal/"` 与现有页面引用路径一致；manifest 的 `action` 字段引用既有 Action Registry 名称（如 `crm-account-360`、`crm-approval-start`）。
4. **风险点**：iframe 的 `/portal/<page>.html` 路径需本地 4173 服务验证（Task1 Step4）；若实际挂载前缀不同（如 `/web/`），仅改 `PAGE_BASE` 常量即可，不影响其他逻辑。
