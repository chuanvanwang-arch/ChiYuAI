# KMD 探针 D1 / D4 生产闭合验证报告

**日期**：2026-09-14 ｜ **执行方**：自动化 c49a0333 ｜ **授权**：用户「确认」批准 D4/D1 设计与实现

---

## 1. 结论（结论先行）

| 项 | 状态 | 依据 |
|---|---|---|
| **D1 真向量覆盖率** | 🟢 GREEN | 生产 `crm.particles.embedding` 维度 384→1024；14/14 个 CRM_KNOWLEDGE 粒子回填为真模型向量（real_vector_pct=100%，0 哈希指纹） |
| **D4 业务结果回流** | 🟢 结构性就绪 | `crm.outcome_event_map` 已播种 4 条启用规则；近 7 天生产无决策事件触发 → 0 回流属预期（非缺陷） |
| 本地 git 工作树 | ✅ 已清理 | release 后 WIP 完整还原（24 D + 10 M + 未跟踪），stash 已清空 |

> **重要说明**：`scripts/kmd-closure-probe.mjs` 直接重跑仍会显示 D1/D4 🔴，但那是**连错库造成的假红**（见 §3），并非生产回退。生产真值须在 `crm-pg` 容器取数，见 §2.5。

---

## 2. 生产侧执行链路（已落地）

1. **发布**：`deploy-remote.py release` → `RELEASE_EXIT=0`。真实发布（表数 61 不变 = `.env` 未被抹，KEEP_RELATIVE_PATHS 修复生效；无「下一步：编辑该文件」P0 守卫未触发）。
2. **D1 维度变更**：`ALTER TABLE crm.particles ALTER COLUMN embedding TYPE vector(1024) USING NULL;` → `embedding_dim=1024` 已验证。
3. **D4 种子**（`db/seed-outcome-event-map-2026-09-14.sql`，4 条幂等 `ON CONFLICT DO NOTHING`）：
   - `contract_sign → won`
   - `deal-advance → partial`
   - `quote-create → other`
   - `deal-archive → lost`
4. **真向量回填**：`scripts/backfill-knowledge-embeddings.mjs` 跑于生产容器（`EMBEDDING_PROVIDER=model` 已激活，SiliconFlow `BAAI/bge-large-zh-v1.5` 1024 维）→ `candidate=4 ok=4 skip=0`；真值 `0|14|14`（null / 非 null / 总 CRM_KNOWLEDGE）。
5. **D1 探针真值**（直接在 `crm-pg` 跑探针 D1 SQL）：`14|14|0` → `real_vector_pct=100%` → **GREEN**。
6. **HTTPS 恢复**：certbot 部署证书，三容器 healthy。

---

## 3. 关键修正：探针 DB 归属（解释「为什么本地跑还是红」）

- `scripts/kmd-closure-probe.mjs` 自带连接：`host:'localhost', port:5433, database: DB_MODE==='test'?'crm_native_test':'crm_native'`，**不读 `PGDATABASE` env**。
- 用户机器 `localhost:5433` = **本地 dev 库**（69 行哈希粒子，从未 ALTER/回填）→ 探针读本地 `crm_native` 报 D1 🔴 是**假红**，根因是连错库，不是生产回退。
- 生产真值须直接对 `crm-pg` 容器取数（本自动化已做）。
- ⚠ **后续建议**：探针应支持 `--host/--port/--db` 显式参数或读 `PGDATABASE`，避免再出现「本地红 = 生产红」误读。

---

## 4. 未决项（HITL / 待用户）

- **D6 校准 70 积压**（HIGH 10 / MED 32 / LOW 28，最老 8.8 天）：治理缺口，禁自动 apply，须管理员审批流消费。
- **GitHub push**：沙箱无凭据，`git push origin feat-multi-industry-meta-model` 仍失败 → 待用户本地推送。
- **裸 IP:80 返回 200**：`sites-available/default` 与 `conf.d/ip-default.conf` 争 `default_server`（既存冲突，非本次引入）→ 未擅自改线上默认站，留待用户决策。
- **本地 WIP 仍持有**：24 D（专利/IP 删除，待用户确认）+ 10 M（并行会话改动）+ 未跟踪 lead-pool 文件，均未提交。

---

## 5. 本地 git 清理（本自动化收尾步骤）

release 后 `git stash pop` 部分失败，本轮外科手术式还原：

- 2 缺失 M（`scripts/e2e-lead-pool-actions.mjs`、`test/portal/layoutMenu.test.js`）经 `git checkout stash@{0} --` 还原；
- 23 缺失 D（专利文件，UTF-8 路径）经 `git diff stash@{0}^1 stash@{0} -z --name-only --diff-filter=D` + Python `os.remove` 安全删除（stash 作备份，零损失）；
- 验证 `D=24 / M=10 / A=0 / ??=12`，与 release 前 WIP 完全一致；
- `git stash drop stash@{0}`（`7cee1661`）清空，无损失。

---

**最终判定**：KMD 探针 D1（真向量）、D4（业务结果回流）两项持续性架构缺口已在生产闭合；探针脚本本地重跑的 🔴 为连错库假红。D6 校准积压为独立治理项，不随本发布消解，待管理员审批流。
