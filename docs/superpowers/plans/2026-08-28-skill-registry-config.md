# 配置中心第 16 项：方法论 SKILL 注册表 深度管理页（skill_registry 持久化 + 启停编辑）

> **Agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（推荐）或 executing-plans 逐 Task 实现。Steps 用 checkbox 追踪。
>
> **状态**：设计（待批准）→ 批准后 TDD 实现。

---

## §0 背景与缺口（用户 2026-08-28 问「配置中心 28 项全完成了吗？」暴露）

配置中心 18 项 = **17 ready + 1 readable（第 16「方法论 SKILL 注册表」）+ 0 pending**。第 16 项当前仅
`GET /api/methodology/skew`，且它返回的是 **SKILL↔DB 维度漂移清单**（`{skew:[...]}`，routes.js:950-954），
**并非注册表快照**；同时 **`crm.skill_registry` 表根本不存在**（schema.sql 21 表无它），
`src/skills/registry.js` 是**内存 Map**（registry.js:8 `const skills = new Map()`），
`enabled` 只是注册块可选布尔、**不持久化**（registry.js:12 注释「后台停用开关」，DB 无承载）。
蓝图 `2026-08-26-frontend-config-pages-master-blueprint.md:376` 对 S21 明确定位：
`GET/PUT /api/config/skill-registry`（落 `skill_registry`），即应支持 **enable/停用启停编辑**。

**结论**：第 16 项真实缺口不止「缺 PUT」——是 **①缺 DB 表 ②缺 GET/PUT 注册表端点 ③缺引擎接线（启停真正生效）
④缺管理页**。本设计一次性补齐，翻 ready。

## §1 现状证据（探查结果）

| 现状点 | 证据 |
|---|---|
| `crm.skill_registry` 表不存在 | schema.sql:11-354 21 张 CREATE TABLE，无 skill_registry |
| registry 为内存 Map | src/skills/registry.js:8 `const skills = new Map()` |
| enabled 不落 DB | registry.js:12 注释；seed.js 注册时仅传内存块 |
| 每 SKILL 目录有 registry.json（含 enabled/rbac_roles/methodology_id） | skills/method-bant/registry.json:8-11（methodology_id/structure/rbac_roles/enabled） |
| GET /api/methodology/skew 是漂移清单 | routes.js:950-954 `{skew: listMethodologySkew()}`（methodologySync.js:167-186 实际实现） |
| 11 个 SKILL 目录 | skills/method-{bant,meddicc,opportunity-matrix,role-map,risk-tradeoff,stop-loss,fact-vs-script,presales} + skills/crm-{native,query,write,risk} |
| methodology 镜像表存在 | schema.sql:120 methodology_template / :127 methodology_dimension（syncMethodologyFromSkill 写这两表） |
| 第0闸写范式 | configRouter.js:57-81（PUT 经 requireDecision + recordDecisionEvent('config_change')） |

## §2 设计决策（对齐蓝图 D2：受控 Schema 契约 + 统一渲染器）

| 决策点 | 结论 | 理由 |
|---|---|---|
| D1 数据落点 | 新建 `crm.skill_registry` 表（schema.sql 追加） | 启停需 DB 持久化（重启不丢）；registry.js 内存态仅是运行快照 |
| D2 启停事实源 | **DB 为权威源**；SKILL 目录 registry.json 的 enabled 为**初始种子**（首启幂等灌入 DB），此后启停一律写 DB | §6.6 单一事实源纪律：后台开关在 DB，SKILL 声明是出厂默认 |
| D3 引擎接线 | registry.js `getSkill()` 启动时读 DB 覆盖内存声明（DB enabled=false → 装载但禁执行）；`canExecuteSkill` 已支持 enabled 闸 | 启停立即生效，无需重启 |
| D4 端点 | `GET/PUT /api/config/skill-registry`（对齐蓝图 S21 命名） | GET 返回全量注册表快照；PUT body `{skill_id, enabled}`（patch 语义） |
| D5 写闸 | PUT 走 **决策第0闸**（requireDecision + config_change 事件）+ **sysadmin** 权限 + **禁删**（只改 enabled，物理行保留） | 与其余 17 个配置项同一纪律 |
| D6 页面 | `skills.html` + `skillRegistryRender.js` 子模块（零服务端 import） | 与 11-28 项同范式；import Render 子模块防浏览器 ESM 崩溃 |
| D7 SKILL 快照 | GET 列表来源 = `listMethodologySkills()`（SKILL 目录实扫）+ DB enabled 覆盖 | 与 methodologySync 的「SKILL 为事实源、DB 镜像」一致 |
| D8 范围 | 只做 enabled 启停（YAGNI：不做 rbac_roles 编辑/版本管理/删除） | 第 16 项 note「启用开关同步」即此 |

## §3 DB Schema（schema.sql 追加、幂等）

```sql
-- 方法论 SKILL 注册表（§6.6 后台启停开关；DB=权威源，SKILL 目录 registry.json=出厂默认）
CREATE TABLE IF NOT EXISTS crm.skill_registry (
  skill_id       TEXT PRIMARY KEY,          -- skills/ 目录名（method-bant / crm-native …）
  category       TEXT NOT NULL DEFAULT 'methodology', -- methodology | action
  enabled        BOOLEAN NOT NULL DEFAULT true,       -- 后台开关（false=引擎禁装载/市场不暴露）
  rbac_roles     TEXT[] NOT NULL DEFAULT '{}',
  methodology_id TEXT,                      -- 方法论镜像 id（method-* 才有）
  updated_by     TEXT NOT NULL DEFAULT 'system',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## §4 实现步骤（TDD RED→GREEN，5 Task）

### Task 1: schema.sql 追加 skill_registry 表 + migrate 幂等
- [ ] 修改 `db/schema.sql` 末尾追加 §3 的 CREATE TABLE（幂等 IF NOT EXISTS）
- [ ] `node --check` 无关；跑 migrate 冒烟（若 PG 不可用则标注环境，代码先落）

### Task 2: 后端 skillRegistry.js（读 DB + 灌种子 + 启停写）

新建 `src/skills/skillRegistry.js`：

```js
// src/skills/skillRegistry.js — 方法论 SKILL 注册表（DB 持久化；§6.6 后台启停）
import { query } from '../db.js';
import { listMethodologySkills } from './methodologySync.js'; // SKILL 目录实扫（含 registry.json）

// 首启幂等：把 11 个 SKILL 目录的 registry.json 声明灌入 skill_registry（不覆盖既有 DB 状态）
export async function seedSkillRegistry() {
  const skills = listMethodologySkills(); // [{skill_id, methodology_id, role, ...}]
  for (const s of skills.concat(crmSkills())) {
    await query(
      `INSERT INTO skill_registry (skill_id, category, enabled, rbac_roles, methodology_id)
       VALUES ($1,$2,true,$3,$4)
       ON CONFLICT (skill_id) DO NOTHING`,
      [s.skill_id, s.category, s.rbac_roles || [], s.methodology_id || null]
    );
  }
}

// DB 快照（管理页 GET 用）——JOIN skill_registry 与 SKILL 目录实扫，DB enabled 为权威
export async function listSkillRegistry() {
  const dbRows = (await query(`SELECT * FROM skill_registry ORDER BY skill_id`)).rows;
  const skills = listMethodologySkills();
  const map = new Map(dbRows.map((r) => [r.skill_id, r]));
  return skills.map((s) => {
    const db = map.get(s.skill_id);
    return {
      skill_id: s.skill_id,
      methodology_id: s.methodology_id,
      category: db?.category || 'methodology',
      enabled: db ? db.enabled : true,   // DB 权威；无 DB 行（未种子）→ SKILL 声明
      rbac_roles: db?.rbac_roles || s.rbac_roles || [],
      source: db ? 'db' : 'skill',
    };
  });
}

// 启停写（PUT）——只改 enabled，禁删；返回 DB 态
export async function setSkillEnabled(skillId, enabled) {
  const r = await query(
    `UPDATE skill_registry SET enabled=$2, updated_by=$3, updated_at=now()
     WHERE skill_id=$1 RETURNING skill_id,category,enabled,rbac_roles,methodology_id`,
    [skillId, !!enabled, 'admin']
  );
  if (!r.rows.length) throw new Error(`skill_registry 无 ${skillId}（未种子）`);
  return r.rows[0];
}
```
> crmSkills()：对 4 个 crm-* 目录同样登记（category='action'）——实现时补该小函数（扫 skills/crm-* 的 registry.json）。

### Task 3: 注册表 Router（GET/PUT + 第0闸）

新建 `src/portal/skillRegistry.js`（Router + handlers 注入式，测试直调 handlers）：

```js
// GET /api/config/skill-registry → {skills:[...], total}
// PUT /api/config/skill-registry → body {skill_id, enabled}；写经第0闸（requireDecision→config_change 事件）+ sysadmin
// 禁删：只改 enabled；未知 skill_id / 非布尔 enabled → 400
```

### Task 4: routes.js 挂载 + 静态段 + configCenter 翻 ready
- [ ] routes.js import + `app.use(createSkillRegistryRouter(...))`（挂 sysadmin 段旁）
- [ ] `GET /skills.html` + `/skills` 302 + `/portal/skillRegistryRender.js` 静态段（Content-Type:text/javascript）
- [ ] configCenter.js:14 第 16 项 `readable→ready`（page:'/skills.html', endpoint:'/api/config/skill-registry'）
- [ ] 引擎接线：registry.js 启动处读 DB enabled 覆盖内存（D3）——最小实现：`applySkillRegistryFromDb()` 在 server 启动后调一次

### Task 5: 页面 + 前端 Render 子模块 + 测试
- [ ] `src/portal/skillRegistryRender.js`：`renderSkillRegistry(rows)`（表格：skill_id/category/enabled 开关/rbac_roles/methodology_id；enabled 用 checkbox）+ 空态
- [ ] `src/web/skills.html`：import Render 子模块 + `/web/nav.js` + token 守卫 + GET 渲染 + PUT 保存（`{skill_id, enabled}`）+ 15s 刷新
- [ ] `src/web/nav.js`：加「📚 SKILL 注册表」入口
- [ ] `test/web/skillRegistry.test.js`：3 组（render 表格含 enabled 开关 / 空态 / 校验函数）+ 后端 handlers 2 例（GET 返回 skills、PUT 走第0闸+禁删）——**RED→GREEN**
- [ ] `test/web/browserLoadable.test.js`：CASES 15→16（skillRegistryRender.js→skills.html，mixed=skillRegistry.js 真实存在）

## §5 验收口径

- `test/web/skillRegistry.test.js` 全绿；`test/web` 全量 **201+新增 → 全绿**；browserLoadable 16 CASE
- `GET /api/config/skill-registry` 返回 11 个 SKILL 快照（enabled 取自 DB 权威）
- `PUT {skill_id, enabled:false}` → enabled 翻 false + config_change 决策事件；重启后仍 false（DB 持久）
- configCenter 第 16 项 `readable→ready` → **18 项全 ready**（配置中心 100% 收口）
- 禁删纪律：无 DELETE 路由；只改 enabled；未知 skill_id → 400

## §6 已知限制

- 启停只对「引擎执行闸」生效（canExecuteSkill 的 enabled 检查）；已装载内存块不卸载——`applySkillRegistryFromDb` 在启动时应用，运行中 PUT 后引擎下次 `getSkill` 读内存仍是旧 enabled → **最小实现：PUT 后同步更新内存 Map**（setSkillEnabled 里同步 `skills.set`），保证立即生效。
- methodologySync 的 /api/methodology/sync（POST，无 sysadmin 闸）与 /api/methodology/skew 保留不动（只读镜像同步工具，非注册表面）。
- 七维 scene-quote 拦截不适用于本面（无 decisionScene）——PUT 直接第0闸即可。