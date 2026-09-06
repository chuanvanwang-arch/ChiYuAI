# UI 架构级 Lint 清理设计（scripts/ui-lint.mjs 警告收敛）

> 整理时间：2026-09-04
> 目的：收敛 `ui-lint.mjs` 当前 36 处**警告**（item 3 样式漂移 13 处 + item 7 JS 模板裸控件 23 处），根治设计系统漂移根因。
> 资料来源：`scripts/ui-lint.mjs`（规则）、`src/web/common.css`（设计系统单源）、`src/web/components.js`（crm-* 组件）、9 个待修 HTML。

## §0 结论先行

- 这 36 处目前**仅是警告**（`ui-lint` 默认 exit 0，不阻断 CI）；item 4（light DOM 裸控件）已零违规。
- **不能盲转 `crm-*`**：`ontology.html:108` 与 `users.html:195` 用 `new FormData(f).entries()` 读值——`crm-*` 组件当前**非表单关联（FACE）**，转后 `FormData` 为空 → 两个管理页"创建/保存"静默提交空数据；且 `type="submit"` 原生按钮转 `<crm-button>` 后不再触发表单提交。
- **根因修复 = 增强 `components.js`**（让 4 个表单控件成为 FACE + 镜像全部按钮变体类），再迁移 9 个页面。这是单源修复、对所有页面复用、且能顺带修掉 latent bug（pipeline 新建商机弹窗已用 crm-input 但大概率同样 FormData 取不到值）。

## §1 违规清单（已逐文件核验）

| 文件 | 类型 | 具体类/标签 |
|---|---|---|
| named-account-manage.html | B 样式漂移 | `.tabs` `.tab` `.badge` `.btn` |
| named-accounts.html | B 样式漂移 | `.tabs` `.tab` `.btn`(`.empty-hint .btn`) `.card` |
| pipeline.html | B 样式漂移 | `.toast` |
| receivables.html | B 样式漂移 | `.card`(`.ov .card*` ×3) |
| meta-attr-drawer.html | A JS 模板 | `<input>` 预览（无表单，安全） |
| ontology.html | A JS 模板 | `<button>`×2 `<input>`×2(含 checkbox) `<select>`×2（**在 FormData 表单内**） |
| portal-stage3-mockup.html | A JS 模板 | `<button class="cta">`（mockup，无表单） |
| sales-decision-monitor.html | A JS 模板 | `<textarea>`×1 `<button>`×7（`.snap-write-btn`/`.btn`/`.dn-drawer-close`/`.dn-close`） |
| users.html | A JS 模板 | `<button>`×7 `<select>`×2 `<input>`×6(含 checkbox/password/datetime-local)（**在 FormData 表单内**） |

## §2 根因修复策略

### 2.1 增强 `src/web/components.js`（单源，所有页面复用）
1. **表单关联（FACE）**：`crm-input`/`crm-select`/`crm-textarea`/`crm-checkbox` 加 `static formAssociated = true` + `ElementInternals`，实现 `formAssociatedCallback`/`formResetCallback`；`value` 经 `internals.setFormValue(name, value)` 参与 `FormData` 与 `required` 校验；`form.reset()` 可重置。
   - 副作用：现有已用 crm-* 的表单（pipeline 新建商机）将**从"取不到值"变为"可取"**，属正向修复，需冒烟验证。
2. **按钮变体类全镜像**：在 shadow 样式 `T` 中补齐各页用到的变体——`.snap-write-btn`、`.cta`、`.dn-close`（当前仅镜像 `.btn-primary/.ok/.cancel/.drawer-close/.btn-ghost/.sec`）。
3. **提交按钮**：`<crm-button type="submit">` 在 shadow 内 `button.type='submit'` 仍不触发表单（自定义元素非提交控件）；统一在页面模板改为 `onclick="this.closest('form').requestSubmit()"`（crm-button 转发 click，host 的 onclick 触发）。`requestSubmit()` 程序化触发提交+校验，兼容当前 `onsubmit` 处理器。

### 2.2 Type B 样式漂移（4 文件）
- 删除本地 `<style>` 中对 `common.css` 已拥有类的**重复基样式**（`.tabs/.tab/.badge/.btn/.card/.toast`），回落到设计系统单源（视觉向 canonical 对齐，符合 lint 本意）。
- 复合选择器中含保留类者改元素选择器：`.empty-hint .btn` → `.empty-hint crm-button`（对齐未来 crm-button）。
- `.ov .card*`（receivables）当前由 JS 用 `<div class="card">` 生成：为避免视觉回退，将 JS 生成类改为页面局部非保留类 `.rcard` 并同步 CSS（零视觉变更），或直接迁移 `<crm-card>`（推荐，单源）。本设计选 **`<crm-card>` 迁移**。

### 2.3 Type A 动态控件（5 文件）
- 无表单的安全控件直接转：meta-attr-drawer `<input>`→`<crm-input>`；portal-stage3-mockup `<button class="cta">`→`<crm-button class="cta">`；sales-decision-monitor `<textarea>`→`<crm-textarea>`、各 `<button>`→`<crm-button>`（变体类已在 2.1 镜像）。
- **表单内控件**（ontology/users）转 crm-* 后，因 2.1 FACE 增强，`FormData(f)` 仍可取到值；`type="submit"` 按钮加 `onclick="this.closest('form').requestSubmit()"`。
- `type="checkbox"` → `<crm-checkbox>`（FACE 后参与 FormData，`name`/`value`/`checked` 透传）。
- `type="password"/"datetime-local"` → `<crm-input type=...>`（已支持 type 透传）。

## §3 验收（必须全过）

1. `node scripts/ui-lint.mjs --strict` → 0 错误 0 警告（exit 0）。
2. 浏览器冒烟（dev server localhost:3000）：
   - ontology：新增词汇 / 编辑停用 → 提交后后端收到正确字段（非空）。
   - users：新建用户 / 编辑保存 / 批量启用冻结设置有效期 → FormData 取到值。
   - sales-decision-monitor：复盘提交、补录、决策网络打开/关闭按钮样式正常。
   - pipeline：新建商机弹窗提交取到字段。
3. 视觉回归：4 个样式漂移页回落 common.css canonical（tabs/card/toast/badge 风格统一），无空白/错位。

## §4 任务拆分（每 Task 一 commit，AI 不提交）

- **Task 1**：`components.js` FACE 增强 + 按钮变体镜像 + 提交按钮 requestSubmit 约定（含组件单测：FormData 取值 / reset / required）。
- **Task 2**：Type B 4 文件样式漂移清理（named-account-manage / named-accounts / pipeline / receivables）。
- **Task 3**：Type A 5 文件动态控件迁移（meta-attr-drawer / ontology / portal-stage3-mockup / sales-decision-monitor / users）。
- **Task 4**：`--strict` 验收 + 浏览器冒烟记录（`docs/2026-09-04-ui-lint-cleanup-impl-log.md`）。

## §5 风险与边界

- FACE 增强改**共享组件**，影响所有使用 crm-* 的页面 → Task 1 后必须跑全站冒烟（不只这 9 页）。
- `ElementInternals` 需浏览器支持（现代浏览器均支持；Node/vitest 无 DOM，组件已有 `registerComponents(){}` 空实现兜底）。
- 不触碰 item 1/2/5/6（已合规）；不引入新设计系统类，零新增行业字面量。

## §6 待拍板

- 默认方案：TYPE B 删除重声明 + TYPE A 走 FACE 增强后迁移（根治，推荐）。
- 替代（仅消警告、不根治）：TYPE A 不改组件，转 crm-* 但接受"表单用 JS getElementById 改读 crm-* 的 .value"——需同步改两处 onSubmit 取值逻辑，且 FormData 仍不可用。**不推荐**（留 latent 不一致）。
