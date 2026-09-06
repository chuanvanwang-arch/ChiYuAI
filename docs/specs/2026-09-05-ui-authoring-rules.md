# src/web 页面撰写规范（UI 架构级封死 · 作者侧唯一准入清单）

> 目的：**一次写对，不在提交时被拦截。** 本文件是写/改 `src/web/*.html` 前的必读清单。
> 执行者：`scripts/ui-lint.mjs`（pre-commit 强制，违规 exit 1）。
> 速查命令：`node scripts/ui-lint.mjs --rules`
> 生成合规骨架：`node scripts/new-page.mjs <page-name> --title "标题"`
> 关联设计：`docs/specs/2026-08-29-ui-arch-lock-design.md`

---

## 0. 三十秒版（写完 HTML 立刻自查这 6 条）

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | `<head>` | 含 `components.js` + `tokens.css` + `common.css` |
| 2 | `<title>` | 纯文字，无 emoji |
| 3 | 控件 | 只有 `crm-*`，**零**裸 `select/input/textarea/button`（`type=hidden` 除外） |
| 4 | 页眉 | `<header class="page-head">`，内部只有标题 |
| 5 | 描述文字 | 放 `<header>` 之后的 `.page-sub`，不放页眉里 |
| 6 | 本地 `<style>` | 不重声明 `btn/card/table/tab/tabs/badge/chip/toast/panel/select/input/textarea` |

改完必跑：`node scripts/ui-lint.mjs`

---

## 1. 规则明细（R1–R7）

### R1 · head 三件套（架构级）
```html
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<script type="module" src="/portal/components.js"></script>
```
缺少任意一个即失败。顺序不限，但 `components.js` 必须在控件使用之前加载。

### R2 · title 禁 emoji（架构级）
`<title>费用中心 · 多租户计费</title>` ✅ ／ `<title>💰 费用中心</title>` ❌

### R3 · 样式不漂移（警告；`--strict` 失败）
设计系统保留类（无连字符的基类）**禁止**在页面本地 `<style>` 中重新声明：
`btn / select / input / textarea / button / card / table / tab / tabs / badge / chip / toast / panel`

确需差异化，两种合规做法：
1. 用**页面前缀私有类**：`.billing-badge`、`.tenant-row`（推荐）；
2. 用**带连字符的变体**：`.btn-primary`、`.tab-sm`（lint 只查无连字符基类）。

### R4 · 控件必须 crm-*（架构级，最常见的拦截点）

| 想写 | 必须写 |
|---|---|
| `<select>` | `<crm-select id="x">…<option>…</option></crm-select>` |
| `<input type="text">` | `<crm-input id="x" type="text" placeholder="…">` |
| `<textarea>` | `<crm-textarea id="x">` |
| `<button>` | `<crm-button id="x" class="btn">` |
| `<input type="hidden">` | 允许保持原生（唯一豁免） |

**取值方式不变**：`el.value`、`el.addEventListener('change', …)` 照旧可用（组件内部代理原生控件并转发 change）。
**动态填充选项**：直接 `el.innerHTML = '<option …>'` 或 `appendChild(option)`，组件通过 MutationObserver 自动同步。

### R5 · 页眉统一（架构级）
只允许 `<header class="page-head">`。禁止 `portal-head` / `drawer-head` / `nl-head` / `head` 等并存类名。
标准结构：
```html
<header class="page-head"><div class="ph-main"><h1 class="page-title">标题</h1></div></header>
```

### R6 · 页眉只留标题（架构级）
`<header>` 内**不得**出现 `.page-sub` / `.muted` / `.sub`。描述写在这里：
```html
<header class="page-head">…</header>
<div class="page-sub">一句话说明本页用途</div>
```

### R7 · 动态直出同样受约束（警告；`--strict` 失败）
JS 模板字符串拼接出来的控件也是 `crm-*`：
```js
// ❌ rows.push('<button class="btn">编辑</button>')
// ✅
rows.push('<crm-button class="btn" data-id="' + id + '">编辑</crm-button>');
```
这是历史最大逃逸面（曾实测 36 处 / 9 文件），新代码不允许再新增。

---

## 2. 标准流程（写新页面 / 大改页面）

1. **起手用脚手架**（不要手搓 head/页眉）：
   ```powershell
   node scripts/new-page.mjs my-page --title "我的页面"
   ```
   骨架已含 head 三件套、`page-head`、示例 `crm-input/crm-select/crm-button`，生成即通过 `--strict`；不合规会自动回滚删除。
2. 补业务逻辑（接口、表格、事件）。新增控件一律 `crm-*`。
3. 提交前：`node scripts/ui-lint.mjs`（pre-commit 会跑，失败即阻断）。

## 3. 常见踩坑

| 现象 | 根因 | 处置 |
|---|---|---|
| 提交被 UI lint 拦，报「裸 `<select>`」 | 手写了原生控件 | 换 `crm-select`，JS 取值代码无需改 |
| 报错只在**注释/文档字符串**里出现裸标签 | lint 不做注释剥离 | 注释里改用「裸控件标签」这类描述，不要写真实标签字面量 |
| 页面被移入 `.workbuddy/backups/<日期>/` | hook 对未提交 HTML 的归档动作 | 从 backups 目录 `cp` 回 `src/web/`；提交后不再发生 |
| `--strict` 有大量历史警告 | 存量页面（billing/landing/propagation-hub）样式漂移 | 新页面不受影响（脚手架自检只校验本文件）；存量按 R3 逐步收敛 |
| 控制台报 `crm-*` 未定义 | 缺 `components.js` | 按 R1 补 `<script type="module" src="/portal/components.js">` |

## 4. 责任边界

- **lint 报错必须给出修法**：`scripts/ui-lint.mjs` 每条违规尾部带 `→ 修复[R#]`，禁止只报行号。
- **新规则先落文档再落 lint**：改动 `ui-lint.mjs` 时同步更新本文件，并在输出中保留 `--rules` 入口。
- **禁止为过 lint 而弱化规则**：不允许把违规页面加入排除名单；确有例外须在本文档登记理由。
