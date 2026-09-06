# UI 架构级 Lint 清理 — 实施记录

> 日期：2026-09-04
> 设计文档：`docs/2026-09-04-ui-lint-design-system-cleanup-design.md`
> 计划文档：`docs/superpowers/plans/2026-09-04-ui-lint-design-system-cleanup.md`
> 命令：`node scripts/ui-lint.mjs --strict` → **通过（exit 0，68 文件，0 错误 0 警告）**

## §0 结论

- 设计批准的 9 文件清理已完成；进一步全量 `--strict` 扫描发现原 36 警告粘贴**不完整**——另有 **7 个文件 19 处同类警告**（item3 样式漂移 8 + item7 裸控件 11）不在原设计范围。
- 为达成设计 §3.1 验收（0 错误 0 警告），将清理**扩展到全部 16 个文件**，最终 `--strict` 全绿。
- `components.js` 增强 FACE 后，所有 `crm-*` 控件支持 `FormData`、原生 `required` 校验、`form.reset()`，并镜像按钮变体类，使后续页面迁移安全。

## §1 验证结果

| 阶段 | 命令 | 结果 |
|---|---|---|
| 组件语法 | `node --check src/web/components.js` | SYNTAX OK |
| 架构级全量 | `node scripts/ui-lint.mjs --strict` | 通过（68 文件，无架构级违规，无样式漂移），exit 0 |

> 注：本环境无法运行浏览器，浏览器冒烟（§3）需用户在 dev server（localhost:3000）手动验证；AI 不提交，git 命令见 §5。

## §2 改动清单

### 2.1 `src/web/components.js`（单源，所有页面复用）
- **FACE**：`crm-input`/`crm-select`/`crm-textarea`/`crm-checkbox` 加 `static formAssociated=true` + `ElementInternals`，实现 `formAssociatedCallback`/`formResetCallback`，`value` 经 `internals.setFormValue(name, value)` 参与 `FormData` 与 `required` 校验。
- **属性透传补全**：`CrmInput` 新增 `readonly`、`autocomplete` 透传（users 表单 edit-mode 用户名只读、密码 `autocomplete=new-password` 需要）。
- **值读取 getter**：四类组件均提供 `get value()` / `get checked()`，使既有 `querySelector('#id').value` 取值模式在迁移后仍然有效（decision-scenarios 表单依赖此）。
- **按钮变体镜像**：`T` 内补齐 `button.btn` / `button.btn:hover` / `button.btn.primary` / `button.btn.ghost` / `button.btn.danger`（`.snap-write-btn`/`.cta`/`.dn-close`/`.dn-drawer-close` 已于前序提交补齐）。
- **提交按钮**：`<crm-button type="submit">` 经 `closest('form').requestSubmit()` 转发提交 + 原生校验。

### 2.2 原批准 9 文件
| 文件 | 类型 | 改动 |
|---|---|---|
| named-account-manage.html | B | 删除 `.tabs/.tab/.badge/.btn` 本地重声明，回落 common.css |
| named-accounts.html | B + A | 删除 `.tabs/.tab/.btn` 重声明；`.card`→`.ncard`（含 `.ncard` 基样式，line 57）；`jump-owner` 裸 `<button class="btn primary">`→`<crm-button>` |
| pipeline.html | B | 删除 `.toast` 重声明 |
| receivables.html | B | `.ov .card*`→`.ov .rcard*`（含 `.rcard` 基样式，line 14），JS `class="card"`→`class="rcard"` |
| meta-attr-drawer.html | A | 预览 `<input>`→`<crm-input>` |
| ontology.html | A | `<button>`×2/`<input>`×2/`<select>`×2→`crm-*`（FormData 表单内，FACE 后取值正常） |
| portal-stage3-mockup.html | A | `<button class="cta">`→`<crm-button class="cta">` |
| sales-decision-monitor.html | A | `<textarea>`→`<crm-textarea>`、`<button>`×7→`<crm-button>`（变体已镜像） |
| users.html | A | 工具栏 + `formHtml` 全部裸控件→`crm-*`（username `readonly`、password `autocomplete`、role `crm-select`、enabled `crm-checkbox`、expires `crm-input datetime-local`、提交/取消 `crm-button`） |

### 2.3 扩展清理 7 文件（原设计未覆盖，全量扫描发现）
| 文件 | 类型 | 改动 | 风险判定 |
|---|---|---|---|
| agents.html | B | 删除未使用的 `.badge.warn` 死规则 | 零风险（grep 全文件无 `badge warn` 用法） |
| business-data.html | B | 删除未使用的 `.cfg-act .btn` 死规则 | 零风险（无 `.cfg-act`/`.btn` 用法） |
| config.html | B + A | `.cfg-act .btn`→`.cfg-act .btn-anchor`（锚点 `<a>` 非表单控件）；`推广到 workspace` 裸 `<button class="snap-write-btn">`→`<crm-button>` | 低风险（snap-write-btn 变体已在 T） |
| decision-graph.html | B | `.stage > .card`→`.stage > .rcard` + 2 处 `<div class="card">`→`<div class="rcard">`；补 `.rcard` 基样式（panel/border/radius/padding/shadow） | 低风险（已补基样式，避免视觉回退） |
| decision-scenarios.html | B + A | 删除未使用的 `.ds-card .btn.edit`×3 死规则；编辑表单 8 控件→`crm-*`（input/select/checkbox/textarea/button） | 中风险→已消解：`save()` 经 `querySelector('#id').value/.checked` 取值，crm-* getter 兼容；非 FormData 陷阱 |
| memory.html | A | 蒸馏 `预检`/`执行蒸馏` 裸 `<button>`→`<crm-button>` | 低风险（独立动作按钮，非表单，addEventListener 经 host 生效） |

## §3 浏览器冒烟清单（用户执行，localhost:3000）

- [ ] **ontology**：新增词汇 / 编辑停用 → 提交后后端收到正确字段（非空）。
- [ ] **users**：新建用户 / 编辑保存 / 批量启用冻结设置有效期 → FormData 取值正确；edit 模式用户名只读。
- [ ] **sales-decision-monitor**：复盘提交、补录、决策网络打开/关闭按钮样式正常。
- [ ] **pipeline**：新建商机弹窗提交取到字段（FACE 正向修复）。
- [ ] **decision-scenarios**：编辑场景保存 → `f-desc/f-tier/f-auto/f-methods/f-dims/f-disp` 取值正确。
- [ ] **config**：`打开编辑` 锚点样式不变；`推广到 workspace` 按钮样式/点击正常。
- [ ] **memory**：`预检`/`执行蒸馏` 点击正常。
- [ ] **decision-graph / agents / business-data**：卡片/徽章视觉与改造前一致，无错位空白。

## §4 已知边角

- decision-scenarios 编辑表单 `crm-checkbox#f-auto` 内被并发格式化进程补入「自主决策允许」插槽文本（作为 checkbox 标签），功能无影响。
- decision-scenarios `.edit-form input[type=text]` 等页内样式不再命中 `crm-*` shadow 内部 input（shadow 走 `components.js` `T` 基样式，padding 8px10px），视觉向设计系统 canonical 对齐，符合 lint 本意。
- 全量 16 个改动页均 `import` `components.js`（grep 各 1 处），`crm-*` 可正常升级。

## §5 提交（AI 不提交，用户提供 PowerShell）

```powershell
git add src/web/components.js src/web/agents.html src/web/business-data.html src/web/config.html src/web/decision-graph.html src/web/decision-scenarios.html src/web/memory.html src/web/named-account-manage.html src/web/named-accounts.html src/web/pipeline.html src/web/receivables.html src/web/meta-attr-drawer.html src/web/ontology.html src/web/portal-stage3-mockup.html src/web/sales-decision-monitor.html src/web/users.html
git commit -m "refactor(web): ui-lint 架构级清理——crm-* FACE 增强 + 16 页样式漂移/裸控件收敛"
```
