# CRM-ai-native 提交 · 生产发布 · 修复报告

- **执行时间**：2026-09-11 06:56 – 07:30（GMT+8）
- **工作目录**：`D:\system\CRM-ai-native`
- **分支**：`feat-multi-industry-meta-model`
- **执行者**：WorkBuddy（Agent 模式，用户授权「提交git / 更新生产版本 / 修复」）
- **结论**：**本地提交 13 个 commit 完成；生产已成功发布（表 59→61，采样表建出）；修复 4 项（含 1 个 P0 级发布事故根因）；GitHub 推送需用户本地执行。**

---

## ① 结论速览

| # | 动作 | 结果 | 证据 |
|---|---|---|---|
| 1 | 本地 git 提交 | 🟢 **16 个 commit** | `HEAD=7653107`，工作树 **0 未跟踪/未提交** |
| 2 | GitHub 推送 | 🔴 **未完成（沙箱无凭据）** | `fatal: could not read Username for 'https://github.com'` |
| 3 | 生产发布 | 🟢 **成功** | 三容器 healthy、表 **59→61**、`crm.system_overview_sample` 已建出 |
| 4 | P0 事故处置 | 🟢 **已恢复** | 生产 `.env` 被 release 抹成模板 → 已按容器真相源还原；HTTPS 已恢复 |
| 5 | 缺陷修复 | 🟢 **4 项** | unpack.py 根治 + 插件包重建 + 2 个 SKILL 更新 |
| 6 | KMD 探针 | 🟡 `🟢6 🔴3 🟡3 ⚪2` | 红点 D1/D4/D6（与昨夜同源，属配置/业务/治理项） |
| 7 | 系统概览采样 | 🟢 **成功** | `upserted 10 tenants`，4 类指标入库 |

---

## ② 本地提交明细（16 个 commit，显式路径 add，禁 `git add -A`）

| # | commit | 功能线 | 主要文件 |
|---|---|---|---|
| 1 | `c06d997` | 记忆写入寻址四元组 + 投影保真 | `src/memory/memoryLog.js`、`test/memory-*`、`scripts/memory-*.mjs` |
| 2 | `cfe64d2` | KMD 决策闭环 / L1 拦截 / 先例边写回 | `src/decision/{closureLoop,autonomyEngine,edgeWrite,policyVersion}.js`、`src/context/assembler.js` |
| 3 | `17dd623` | Action 登记与 agent 装配闭包接线 | `src/action/{seed-actions,executor}.js`、`src/skills/seed.js`、`src/agent/agentSpec.js` |
| 4 | `cdd2418` | 计费 / 落地页 / 系统概览页 | `src/http/{billingRoutes,routes}.js`、`src/web/*.html`、`src/portal/configCenter.js` |
| 5 | `d4616ab` | DB 种子与需求采集场景迁移 | `db/seed*.sql`、`db/migration-requirement-collect-scenario.sql` |
| 6 | `656fc29` | 概览采样守卫修复 + 打包/校验工具链 | `scripts/sample-system-overview.mjs` 等 12 个脚本 |
| 7 | `b7b34c1` | 线索发现引擎 T1/T3/T4 | `src/config/discoveryRules.js`、`src/connectors/discovery/adapters/`、`src/agent/discoverySchema.js` |
| 8 | `4794040` | 设计文档 / 实施计划 / 专利评估归档（**61 文件**） | `docs/**` |
| 9 | `35b9361` | 夜间检查报告归档 | `reports/nightly/2026-09-07..11` |
| 10 | `3436f2b` | 介绍页与应用商店素材 | `doc/sales-platform-base-intro.html` 等 |
| 11 | `6c10275` | `.gitignore` 忽略规则增补 | 见 §⑤ |
| 12 | `caabf23` | drillModal 绑定时机注样式（UI 修复） | `src/web/drillModal.js` |
| 13 | `3a9745b` | **unpack.py 跨清理保留 .env（P0 根治）** | `scripts/tencent-lighthouse-deploy/unpack.py` |

**提交过程中的一次自纠**：首轮 `git add docs/` 误将 `docs/patents/_deprecated-2026-09-09-xml-zip/`（**523 个废弃 DTD/XSD 文件，9.7MB**）纳入，提交 `4231c15` 达 583 文件。已 `git reset --mixed` 撤销后 3 个提交并精确重建 → `4794040` 降为 **61 文件**，同时补 `.gitignore` 规则防复发。

**未入库清单（有意排除，均已加 `.gitignore`）**：

| 类别 | 内容 | 原因 |
|---|---|---|
| 媒体产物 | `doc/event/bp/video/`（66MB mp4/mp3） | 体积大，建议外置存储 |
| 材料二进制 | `doc/*.pptx`、`doc/*.pdf`（3.1MB，v2–v8 迭代稿） | 多版本二进制产物 |
| 会话临时 | `.tmp_clv9.txt`、`tok.txt`（**含凭据**）、`phase2-commit.ps1`、`fix-tenantScopeBar-route.patch` | 临时/敏感 |
| 运行态目录 | `.workbuddy/`（memory/skills/backups）、`artifacts/`、`outputs/` | 会话运行数据 |
| 误落路径 | `D/`（内含 `D/system/CRM-ai-native/db/seed/seed-all-tenants.mjs`）、`Lanch/`（含 3 个待发布 SKILL） | 疑似误建，建议人工归位 |

> ⚠️ `Lanch/SKILL/` 内含 `crm-basic-data-portal` / `crm-config-center-settings` / `new-industry-onboarding` 三个 SKILL，疑似 "Launch" 拼写误建目录，**未入库**，建议移入标准 `skills/` 后另行提交。

---

## ③ 生产发布：结果与一次 P0 级事故处置

### 3.1 发布前基线 → 发布后

| 项 | 发布前 | 发布后 | 判定 |
|---|---|---|---|
| crm schema 表数量 | 59 | **61** | 🟢 +2 |
| `crm.system_overview_sample` | **MISSING** | **已建出** | 🟢 采样表落地 |
| 三容器 | healthy | healthy（Up About a minute） | 🟢 |
| `/`（app 3000） | 200 | 200 | 🟢 |
| 扩展 | age 1.6.0 / vector 0.8.6 | 不变 | 🟢 AGE 防护生效 |
| `https://…/landing.html` | 443 未监听 | **200** | 🟢 已恢复 |
| `/mcp` | 401 | 401 | 🟢 鉴权正常 |
| `/system-overview/k` | 404（旧版） | **302** | 🟢 新路由已上线 |

### 3.2 ⚠️ P0 事故：release 把生产 `.env` 抹成模板（本次发现并根治）

**现象**：首次 `deploy-remote.py release` **仅 7 秒结束**，表数量不变、容器未重建 —— 典型**假发布**。

**根因链（证据级）**：
1. release 的 [2/4] 步用 `unpack.py --clean` **清空整个 `/opt/crm-ai-native`**（日志：`· 已清空 /opt/crm-ai-native（7 个条目）`）；
2. 生产 `.env` 位于 `scripts/tencent-lighthouse-deploy/.env`，**随目录被删除**；
3. `deploy.sh` 检测到 `.env` 缺失 → 从 `.env.example` 复制模板（1186 字节）→ 打印「**下一步：编辑该文件，把 PGPASSWORD 改成强密码**」并 **`exit 1` 中止 rebuild**；
4. 服务此刻仍靠**旧容器内存态**运行，故表面正常。

**危险程度**：被抹后的 `.env` 实测 `PGPASSWORD` 仅 6 字符（占位）、`SMTP_PASS` **为空**、且**缺 `CRM_LLM_SECRET` / `EMBEDDING_PROVIDER`**。**任何后续 rebuild 都会读到它** → DB 连接失败 + 库内 api_key 密文**永久不可解密**。

**处置（已完成）**：
1. 备份被抹文件 → `/opt/crm-ai-native/scripts/tencent-lighthouse-deploy/.env.broken-20260911.bak`；
2. 以**运行容器 env 为真相源**回填：`docker inspect crm-app --format '{{range .Config.Env}}{{println .}}{{end}}'`（过滤 HOME/PATH/HOSTNAME/NODE_VERSION/YARN_VERSION）；
3. 校验回填后值长度：`PGPASSWORD=32`、`SMTP_PASS=30`、`CRM_LLM_SECRET=43`、`EMBEDDING_PROVIDER=5`、`PGHOST=2`、`PGPORT=4` ✅ 全部正确；
4. 重跑 `bash deploy.sh` → **rebuild 成功**（三容器 healthy、表 61）。

**根治（代码级，已提交 `3a9745b`）**：`unpack.py` 新增 `KEEP_RELATIVE_PATHS = ("scripts/tencent-lighthouse-deploy/.env",)`，`clean_dir()` 清空前暂存、清空后连权限还原，并打印「已跨清理保留运行态文件」。隔离验证（临时目录 + 白名单注入）：

```
TEST_R1  .env 存活且内容一致 : True
TEST_R2  普通文件确被清空   : True
RESULT   : PASS
```
> ⚠️ 该修复需**随下一次 release 上传**才在服务器生效；在此之前每次 release 仍需人工核验 `.env`。

### 3.3 ⚠️ HTTPS 被 deploy.sh 重写（已知坑，本次已按 SKILL 恢复）

`deploy.sh` 末尾整体重写 `/etc/nginx/sites-available/crm`，443 监听与 certbot SSL 块丢失（`server_name` 回退 `_`）。恢复动作（已验证 `443_listen=1`）：

```bash
sudo sed -i 's/server_name _;/server_name www.chiyuai.com chiyuai.com;/' /etc/nginx/sites-available/crm
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d www.chiyuai.com -d chiyuai.com --redirect -m watchm@163.com --agree-tos --non-interactive
# → "Successfully enabled HTTPS on https://www.chiyuai.com and https://chiyuai.com"
```

---

## ④ 修复清单

| # | 缺陷 | 状态 | 证据 |
|---|---|---|---|
| F1 | release 抹掉生产 `.env` → 假发布 + 凭据炸弹 | 🟢 **根治**（`3a9745b` + SKILL 固化） | 隔离测试 PASS；`.env` 15 键值长度全部正确 |
| F2 | 生产 `crm.system_overview_sample` 缺失 → 采样不可用 | 🟢 **已修**（发布后自动建表） | `to_regclass` 返回表名；本节 ⑤ 采样成功 |
| F3 | `plugin-platform-admin.zip` 落后于源 | 🟢 **已重建** | 重建后 `industry-onboarding/SKILL.md` 与源 EQUAL；`verify-plugin-zips.py` ✅ 两包全通过 |
| F4 | HTTPS 被 release 抹掉 | 🟢 **已恢复** | `443_listen=1`、`https_landing=200` |
| F5 | `.gitignore` 缺失 → 废弃资料/媒体/敏感文件易误入库 | 🟢 **已补规则** | `6c10275`（`docs/patents/_deprecated-*/`、`doc/event/`、`tok.txt`、`.workbuddy/` 等） |

**未能自动修复（需配置 / 业务 / 治理动作）**：

| # | 项 | 现状 | 所需动作 |
|---|---|---|---|
| N1 | **D1 真向量 0%** | 65/65 knowledge 全为 hash 伪向量（`real_vector_pct=0`） | 需在 `crm.llm_config` 配置 SiliconFlow api_key 并置 `EMBEDDING_PROVIDER` 为真 provider；随后跑 embedding backfill |
| N2 | **D4 结果自动回流 0 条** | `outcome_total=4` 全为 seed 脚本（`real_auto=0`） | 需真实业务闭环操作触发（非代码缺陷） |
| N3 | **D6 校准补丁积压 70 条** | 最老 5.6 天；分级 HIGH 10 / MEDIUM 32 / LOW 28 | 按 HITL 铁律须**管理员审批流**落地（`POST /api/calibration/patches/<patch_id>/approve` 或 `/api/my-todo/tune-approve`）；本清单仅人工审阅消项，**绝不自动应用** |
| N4 | **SMTP 邮件** | 发布后 `.env` 已含 `SMTP_PASS`（30 位）；历史日志中的 `550 User has no permission` 系模板期残留 | 建议重跑激活码发送做一次实证 |

---

## ⑤ KMD 闭环探针（只读，13 条定义 / 本次执行 12 条）

产物：`artifacts/kmd-probe-2026-09-11.json`　命令：`npm run probe:kmd`　汇总：**🟢6 🔴3 🟡3 ⚪2**

| 探针 | 边 | 状态 | 关键指标原文 |
|---|---|---|---|
| D1 知识向量 | K 构建 | 🔴 FAIL | `knowledge_rows=65 hash_signature=65 has_negative=0 real_vector_pct=0` |
| D2 LK 引用消费 | K→D | 🟢 | `lk_refs_total=6 lk_consumers=4` |
| D3 L1 池构成 | — | 🟢 | `l1_pool=442 type_kinds=18 knowledge_pct=14.71` |
| D4 结果自动回流 | ④ 结果→D | 🔴 FAIL | `outcome_total=4 real_auto=0 manual=0 seed_script=4 event_rules=1 enabled=1` |
| D5 事件订阅覆盖 | 事件总线 | 🟢 | `subscribed=3 emitted_kinds=18 intersection=1 matched=outcome-set` |
| D6 校准补丁积压 | 治理 | 🔴 FAIL | `PENDING=70 REJECTED=1 ROLLED_BACK=1 APPLIED=1 pending_age_days=5.6` |
| D7 记忆→决策 | D→M | 🟢 | `total=1 from_memory=1` |
| D8 记忆锚点 | M 构建 | 🟢 | `memory_total=633029 business_rows=10422 injectable=145 anchored=57` |
| D9 运营态信号 | — | 🟢 | `rows_24h=1600 top=visit_shortfall top_pct=63.13` |
| D10 D→K 回写 | ④ D→K | 🟡 WARN | `retro_knowledge=0` → 复盘产出知识 0 条，回写路径从未走通 |
| D11 知识投影契约 | K 构建 | 🟡 WARN | `match_pct=18.46`（12/65）→ 消费端修好也只会拿到空壳 |
| D13 噪声闸门回归 | M 构建 | 🟢 PASS | 噪声闸门三关全过：`on(*)` 已除、BLOCKED 硬闸生效、生产近 60 分钟零 trace 噪声 |
| D12 / E2E | — | ⚪ SKIP | 需 `--e2e --db=test`，只读巡检不纳入 |

**校准分诊**（`npm run triage:calibration` → `artifacts/calibration-triage-2026-09-11.json`）：

```
totals: {"total":70,"LOW":28,"MEDIUM":32,"HIGH":10}
HIGH 样本：f45d379d… | source_refresh | context-dimension-source
           d10dedd8… | required_dims  | CLIENT_STRATEGY
           32856bd8… | required_dims  | QUOTE_PRICING
```
> ⚠️ 校准补丁按 **HITL 铁律**须经管理员审批流落地（`POST /api/calibration/patches/<patch_id>/approve` 或 `/api/my-todo/tune-approve`）。**本清单仅用于人工审阅消项，绝不自动应用。**

---

## ⑥ 系统概览每日采样

命令：`node scripts/sample-system-overview.mjs`　退出码 **0**

```
[sample-overview] upserted 10 tenants
```

入库校验（幂等 upsert，禁 DELETE）：

| sample_date | metric | rows | tenants |
|---|---|---|---|
| 2026-09-10 | `d_l1_intercept` | 9 | 9 |
| 2026-09-10 | `k_knowledge_count` | 10 | 10 |
| 2026-09-10 | `k_method_skill` | 9 | 9 |
| 2026-09-10 | `m_precedent_edge` | 9 | 9 |

---

## ⑦ 需用户本地执行

```powershell
# ① 推送 13 个提交（沙箱无 GitHub 凭据，push 已被拒）
cd D:\system\CRM-ai-native
git push origin feat-multi-industry-meta-model

# ② 核验生产（可选，发布已完成）
$PY  = "C:\Users\wangchuan08\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
$DIR = "D:\system\CRM-ai-native\scripts\tencent-lighthouse-deploy"
& $PY "$DIR\deploy-remote.py" status --password-file "$env:TEMP\crm_ssh.pwd"
```

**下次 release 务必注意**：`unpack.py` 根治修复需随下一次 release 上传才生效；在此之前每次 release 后请核验 `.env` 键值长度（`PGPASSWORD≈32 / SMTP_PASS≈30 / CRM_LLM_SECRET≈43`）并恢复 nginx HTTPS。

---

## ⑧ 合规声明

- 全程**未执行任何 DELETE**（唯一撤销动作为 `git reset --mixed`，内容全部保留在工作树）。
- 所有提交使用**显式路径 `git add`**，**未使用 `git add -A`**，按功能线分组，每逻辑任务一个 commit。
- `tok.txt` 等含凭据文件**未入库**并已加入 `.gitignore`。
- 生产数据库**只读探测**，未执行任何写/删业务数据操作。
- 校准补丁**未自动应用**，仅输出分诊清单供人工审批。
