# 设计文档：CRM 平台 UI 架构级封死（Web Component 单一来源）

- **日期**：2026-08-29
- **状态**：已获用户批准（brainstorming 产物）；实施走 writing-plans
- **范围**：`src/web` 全部页面（50+ html）+ `src/web/common.css` + `src/web/tokens.css` + `src/web/page.css` + 新增 `src/web/components.js` / `src/web/util.js` + 新增 `stylelint` 配置 + `pre-commit` hook
- **前置依据**：
  - `docs/specs/2026-08-27-ui-nav-standards-design.md`（导航/主色/tokens 单源，已落地）
  - `docs/specs/spec-style-unify-2026-08-29.md`（内容区页头/tab 统一，已落地但残留）
- **性质**：设计文档（brainstorming 产物）；本文件**不写实现代码**

---

## §0 背景与根因（为什么既有规范没落地）

用户质疑「制定规范却不遵守」。经源码审计，根因不是主观不遵守，而是规范约束力存在 4 处结构性缺口：

| # | 根因 | 证据 | 后果 |
|---|---|---|---|
| R1 | 规范只管 CSS 类，未管原生表单元素 | `common.css:66` 仅 `.form select`（依赖 `.form` 父级）；`account-360.html:15` 的 `#account-select` 不在 `.form` 内；`sales-decision-monitor.html:97` 的 `#calibration select` 仅局部定义 | 下拉框/输入框在深色主题下为系统白色（截图 sales-decision-monitor 白底下拉框） |
| R2 | 规范只禁「删/覆盖既有规则」，未禁「新增本地类」 | `pipeline.html` `<style>` 现场造 `.kpi-block/.insight-overview/.stage-drawer` 等 30+ 行；`sales-decision-monitor.html` 整段 `.dn-*/.cal-*/.task-table` 本地类 | 每页一套组件，视觉割裂 |
| R3 | 金额/数字格式是 JS 字符串拼接，规范未覆盖 | `pipeline.html:103` `'¥'+n.toLocaleString`；`account-360` 渲染「800,000 ¥」、pipeline「5,000,000¥380,000」 | 单位位置/间距/字号不统一 |
| R4 | 规范是 markdown，无强制机制 | 无 stylelint / ESLint / 组件封装 / pre-commit 拦截 | AI 增量加功能时直接散写 `<style>`，零摩擦、无报错 |

**结论**：既有规范定义了「唯一正确形态」（tokens 单源、主色 `#6366f1`、全深色），价值在于提供基准；但它是**设计意图文档**而非**编译期约束**。本设计将其升级为**架构级硬约束**——通过 Web Component 单一来源 + 提交期拦截，使「违反规范」在结构上不可能或提交即失败。

---

## §1 目标与原则

- **G1 根治白底**：全站原生表单控件在深色主题下零白色（下拉框/输入框/按钮）。
- **G2 组件单源**：内容区组件只能来自 `crm-*` / `common.css`，禁止页面散写本地组件类。
- **G3 格式统一**：金额/数字渲染唯一来源 `fmtMoney()` / `fmtNum()`。
- **G4 不破坏现有逻辑**：纯样式壳保证 `value/disabled/事件` 100% 透传，现有 `querySelector` / `addEventListener` 基本不动。
- **原则**：纯样式壳（不引入组件自有状态）、增量迁移（脚本辅助 + 逐页验证）、提交期拦截（防回潮）。

---

## §2 架构分层

### 2.1 组件注册中心 `src/web/components.js`（新建）
- 集中 `customElements.define` 全部 `crm-*` 元素；被 `layout.js` 注入或页面 `import` 一次即全站可用。
- 每个元素：`class XxxElement extends HTMLElement`，`connectedCallback` 内 `attachShadow({mode:'open'})`，shadow 注入 `<style>`（引用 tokens 变量）+ `<slot>` 投影内容。
- 注册入口：在 `layout.js` 顶部 `import './components.js'`，随顶栏/侧栏注入全站一次性注册（无需每页单独 import）。

### 2.2 全局基底（补 `tokens.css` 顶部）
```css
:root{ color-scheme: dark; }
/* 兜底：WC 迁移空窗期，未覆盖的原生元素也深色 */
select,input,textarea,button{
  background:var(--panel); color:var(--ink);
  border:1px solid var(--line); border-radius:8px;
}
```
- 作用：即使某页尚未迁移完，原生元素也因 `color-scheme:dark` 不再白底；WC 全面铺开后此兜底可保留为安全网。

### 2.3 内容组件单源
- 手写页卡片/表格/标签统一走 `crm-*`（§3）；`common.css` 保留 `.page-head/.sect/.page-title` 等**页级骨架类**（已是单源，不 WC）。
- `page.css` 的 `.pg-*` 受控渲染输出**不 WC**（renderPage 字符串输出，本就单源）。

### 2.4 硬拦截（stylelint + pre-commit hook）
- `stylelint` 规则：页面 `<style>` 内禁止出现非白名单 class 选择器（白名单=页级骨架类 + 动画/布局微调）；禁止裸 `select/input/textarea/button` 标签（须 `crm-*`）。
- pre-commit：扫 `src/web/*.html`——未链 `/portal/tokens.css` + `/portal/common.css`、标题含 emoji、散写违规 class → 提交失败并报告行号。
- 沙箱无 git 凭证，hook 脚本由用户本地安装；本设计提供 `.stylelintrc.json` + `scripts/ui-lint.mjs`（可独立运行 + CI 复用）。

### 2.5 JS 格式化单一来源 `src/web/util.js`（新建）
```js
export const fmtMoney = (n, { sign=false }={}) => {
  const v = Number(n); if (!Number.isFinite(v)) return '—';
  const s = v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return (sign && v > 0 ? '+' : '') + '¥' + s;   // 单位右置、无空格粘连
};
export const fmtNum = (n, unit='') => {
  const v = Number(n); if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('zh-CN') + (unit ? ' ' + unit : '');
};
```
- 所有页面金额/数字渲染改为调用，根治 R3。

---

## §3 组件清单与契约

### 3.1 表单四件套（纯样式壳）
| 元素 | 形态 | 关键实现 |
|---|---|---|
| `crm-select` | `<crm-select><option>…</option></crm-select>` | shadow 内 `<select><slot></slot></select>`；`appearance` 统一 + `color-scheme:dark` 根治白底；`value/disabled` 经 `attributeChangedCallback` mirror 到内部 select；change 事件原生冒泡 |
| `crm-input` | `<crm-input><input …></crm-input>` | shadow 内 `<input><slot></slot>`；`placeholder/value/disabled/type` 经 `attributeChangedCallback` mirror 到内部 input |
| `crm-textarea` | 同上 | shadow 内 `<textarea><slot></slot>` |
| `crm-button` | `<crm-button>新建</crm-button>` | shadow 内 `<button><slot></slot></button>`；`variant` 属性映射 `.primary/.ghost/.danger` |

### 3.2 容器组件（纯样式壳，slot 投影内容）
| 元素 | 形态 | 样式职责 |
|---|---|---|
| `crm-card` | `<crm-card>…</crm-card>` | 边框/背景/圆角/内边距（替代 `.kpi-block/.gate/#wb-container` 等本地类） |
| `crm-table` | `<crm-table><table>…</table></crm-table>` | 表格容器边框/溢出/斑马纹 |
| `crm-tabs` + `crm-tab` | `<crm-tabs><crm-tab>画像</crm-tab>…</crm-tabs>` | 替代各页自造 `.tabs/.tab`/`.page-tabs` 覆盖 |

### 3.3 统一契约（已批准）
- shadow DOM **仅做样式隔离**，内部仍是原生元素；`value/disabled/options` 与 `change/input/click` 事件 **100% 透传冒泡**（自定义元素不改变事件传播链，无需手动 redispatch）。
- 样式复用 `tokens.css` 变量；`crm-select` 内部强制 `color-scheme:dark` + `appearance`。
- 不引入组件自有状态/API（纯样式壳，避免过度工程）。

---

## §4 迁移策略（脚本辅助 + 逐页验证 + lint 兜底）

1. **迁移脚本** `scripts/migrate-ui-wc.mjs`（一次性）：
   - 扫 50+ html：`select/input/textarea/button` 裸标签 → 对应 `crm-*` 包裹；常见本地卡片/表格结构 → `crm-card/crm-table`；本地类定义（`.kpi-block/.gate/.dn-*/.cal-*` 等）迁 `common.css` 或删。
   - 金额/数字拼接 → 替换为 `fmtMoney/fmtNum` 调用（JS 块静态替换 + 人工复核）。
2. **逐页冒烟**（本地 server，关键页必验）：pipeline / account-360 / my-todo / sales-decision-monitor / 5 个详情页（deal/quotation/contract/order/payment）/ config / seven-dim / decision-scenarios。
   - 核对：无白底控件、tab 样式一致、金额格式统一、交互（change/input/提交）正常。
3. **lint 兜底**：`scripts/ui-lint.mjs` + pre-commit 拦新增裸元素与散写，防回潮。
4. **回退**：每页迁移独立，单页 `git checkout` 可回退；`components.js` 新增不删改既有类。

---

## §5 验收口径

- **G1**：全站无白色原生控件（下拉框/输入框/按钮），深色主题一致。
- **G2**：无散写非白名单 class；卡片/表格/标签仅 `crm-*` / `common.css`。
- **G3**：金额统一 `fmtMoney`（单位右置、无空格粘连）；数字统一 `fmtNum`。
- **G4**：现有交互（`change/input/表单提交`）不受影响（纯样式壳保证）。
- **规范可查**：`docs/specs/2026-08-29-ui-arch-lock-design.md` 落地；`.stylelintrc.json` + `scripts/ui-lint.mjs` 可执行。
- 回归：全量 vitest（398 基线）+ 关键页实测。

---

## §6 风险与回退

- **R-slot**：shadow DOM 事件透传需 careful 实现（尤其 `crm-select` 的 `change` 冒泡经 slot 内容）。缓解：内部真 select 原生冒泡，不手动 redispatch；逐页测 change 链路。
- **R-mirror**：`value/disabled/options` mirror 遗漏导致状态不同步。缓解：仅 mirror 关键属性，用 `observedAttributes` 精确监听。
- **R-script**：迁移脚本误伤特殊用例（如 pipeline 的 `ndCustTier` 联动、monitor 的 `#calibration select`）。缓解：脚本后逐页人工冒烟 + 单页可回退。
- **R-safari**：`is=` customized built-in 不用，统一用独立 `crm-*` 标签，规避兼容性坑。

---

## §7 交付物与分批

| 批 | 内容 | 验收 |
|---|---|---|
| 1 | `components.js`（四件套 + 容器） + `util.js`（fmtMoney/fmtNum） + `tokens.css` 全局基底 | 单组件本地页验证 |
| 2 | 迁移脚本 + 业务页（pipeline/account-360/my-todo/sales-decision-monitor/详情页） | 关键页冒烟通过 |
| 3 | 其余 40+ 页迁移 + 本地类清理 | 全站无白底/散写 |
| 4 | `.stylelintrc.json` + `scripts/ui-lint.mjs` + pre-commit hook | lint 拦违规、可独立运行 |
| 5 | 回归：vitest 398 + 关键页实测 | 全绿、视觉一致 |

- **不改动**：`layout.js` 顶栏/侧栏逻辑（仅追加 `components.js` 引入）、`routes.js`、后端。
- **提交说明**：沙箱无 git 凭证，AI 不提交；文档与代码由用户本地 `git add` / `git commit`（设计文档建议单独一 commit）。
