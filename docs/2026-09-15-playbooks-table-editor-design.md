# 设计文档：自动策略（Playbooks）可视化表格编辑器

- 日期：2026-09-15
- 来源需求：用户截图红圈「自动策略」Tab（playbooks）= `[]` + 状态「未配置」，核查后确认为出厂默认（非故障）；用户选定 **B｜可视化编辑器**（brainstorming 批准方案③ 极简表格行）。
- 关联：§0 结论见对话；后端 `orchestrationCompiler.js:11-21` / `discoveryOrchestrator.js:53-55` 为事实源。

## 设计约束（硬）
- 不新增粒子类型、不改业务域模型、不动后端（遵循 2026-09-08 已批设计 §10）。
- 数据源/命中信号/数组语义与既有 schema 完全一致（唯一事实源 `src/config/discoveryRules.js`）。
- AI 不 commit；禁 DELETE；配置驱动差异化。

## 方案③ 落地形态（极简表格行）
「自动策略」面板用 `<table class="cfg">` 替代裸 JSON textarea：
| 列 | 字段 | 控件 | 数组处理 |
|----|------|------|----------|
| 名称(必填) | `name` | text（datalist 含 `default`） | — |
| 命中信号(&&) | `match` | text（datalist=7 信号） | 逗号分隔；后端 `&&` 解析 |
| 数据源 | `data` | text（datalist=provider id） | 逗号分隔 → 数组 |
| AI 研究 | `ai` | text | 逗号分隔 → 数组 |
| 执行动作 | `action` | text | 逗号分隔 → 数组 |
| 删除 | — | 按钮 | — |

- 顶部「＋ 新建策略」新增空行；`<details>` 内 `<pre id="pb-preview">` 只读实时 JSON 预览。
- 模型 `let pbRows = []` 为唯一真源；`fill()` 填充并渲染，`collect()` 直接读模型输出 `playbooks` 数组。
- 校验：名称空 → 保存时 `setStatus('策略名称必填')` 并阻断（避免无名 playbook 被后端 `compilePlaybook` 静默抛错/丢弃）。

## 接线点（file:line 锚点）
- `fill()` line 235：原 `getElementById('playbooks-json').value = JSON.stringify(...)` → `pbRows = (v.playbooks||[]).map(normalizePb); renderPlaybooks();`
- `collect()` line 256：原 `playbooks: JSON.parse(getElementById('playbooks-json')...)` → `playbooks: pbRows.filter(p=>p.name).map(toPbObj)`
- 新增：`renderPlaybooks()` / `addPlaybook()` / `splitCsv()` / `normalizePb()` / `updatePbPreview()` + `#pb-add` 监听。
- 删除：`playbooks-json` textarea（由表格+预览取代）。

## 测试契约（discoveryRulesPage.test.js）
- ⑬ 改断言：删 `playbooks-json` placeholder 依赖 → 断言 `pb-body`/`pb-add`/`pb-preview` 存在 + 列头含 5 字段 + 含 `data-i` 行模板机制字面值（`pb-name`/`pb-match`/`pb-data`/`pb-ai`/`pb-action`）。
- ⑭ 新增：表格行渲染（行模板含 `class="pb-row"` + `data-i`）、名称必填闸门字面值 `策略名称必填` 出现、逗号分隔序列化字面值 `split(','` 或 `.split(',')` 出现。

## 回归基线
- `discoveryRulesPage` 全绿（⑬⑭ 守编辑器结构）；`config` 套件 25/25；页面 inline module `node --check` 通过。

## Living Contract（双轨）
```contract-yaml
- task: "实现 playbooks 可视化表格编辑器(discovery-rules.html)"
  agent: web-config-impl
  skills: [ai-portal-page-generation]
  memory: [crm-native]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "discoveryRulesPage 测试含 playbook 编辑器契约(表格行/名称必填/逗号序列化)且全绿；collect() 输出合法 playbooks 数组(pbRows 模型驱动)"
```
