# 2026-08-26 实现状态审计（四问实证核查）

> 方法：实测优先，非凭记录作答。证据 = 全量 vitest 实测 + git 工作树状态 + src/ 文件:line 探针。
> 实测环境：沙箱可直连 PG@5433（plm/crm schema），故全量测试可真实运行。

## 总判定

| 问题 | 结论 | 关键证据 |
|---|---|---|
| 1. 所有任务都开发完毕了？ | **否（代码完成度高，但全部未提交 + 个别设计稿未启动）** | 见 §1 |
| 2. 所有功能都按设计文档实现？ | **主体已落地并通过测试，但未经提交/评审，且存在端点重复债** | 见 §2 |
| 3. 所有任务都有测试报告？ | **测试齐备（466 绿），但无聚合「报告」文档，个别端点/资产仅间接覆盖** | 见 §3 |
| 4. 测试都通过了吗？ | **是。466/466 通过，0 失败，27.34s，本次退出码 = 0** | 见 §4 |

---

## §1 所有任务都开发完毕了？

**代码层面：主要设计线已落地。** 对照 08-26 早间 `gap-inventory.md`（已过时，勿再据此判断）三条未开发主线，实测均已在工作树完成：

- **G1 粒子属性元模型 UI 抽屉**：`src/web/meta-attr-drawer.html` 存在（3185B），`routes.js:328` 经 `../web/`（即 `src/web/`）正确服务；`meta-attr-page.test.js:77` 读同路径断言 `/api/meta-attr` 通过。✅
- **G2 MCP 对外分发四阶段**：`src/mcp/`（config/auth/tools/gateway/server 5 模块）+ `skills/crm-native|crm-query|crm-risk|crm-write/`（各 6 文件）+ `skills/method-{bant,meddicc,opportunity-matrix,role-map,risk-tradeoff,fact-vs-script,stop-loss}/`（各 7-8 文件）全部落盘。✅
- **G3 可观测化 + crm-risk 真扫描**：`src/scheduler/riskScanner.js` 真实 `runRiskScan`（全量重算 AI 属性 + trace）；`timers.js:33-38` 已接 30min 定时器（此前"空占位"已修复）。✅

**但未"完成交付"，两处未决：**

1. **全部改动未提交（丢失风险最高）**：`git status` 显示 12 文件 M + 约 25 未跟踪项。
   - 线 A（`semantica-decision-network-monitoring` 8 Task）已 8 笔 commit 落 master。
   - 线 B（`age-semantica-program` P0-P8）**代码/测试已落地、实测 28/28 绿，但 0 笔 commit，全部 untracked**（`src/mcp/`、`src/decision/conflict.js`、`graphAnalytics.js`、`web/decision-graph.html`、`db/enable-age.sql` 等 + 10 个新测试）。
   - 沙箱无 git 凭证，**需用户在本地 `Git一下`**。
2. **仍有设计稿未实现/未验证**：`docs/2026-08-26-stage3-portal-home-design.md`（门户首页）、`docs/superpowers/plans/2026-08-26-particle-attr-ui-patch.md` + 同名 design（粒子属性 UI 补丁）均为 **untracked、计划 checkbox 全 `- [ ]`**，实现状态未验证（仅见 `src/web/portal-stage3-mockup.html` 原型，非真实落地页）。

---

## §2 所有功能都按设计文档实现？

- **主体对齐**：G1/G2/G3 + Stage1 底座 + Stage3 L2C 业务闭环，均在工作树有对应模块与测试（466 绿为证）。
- **未提交 = 未经评审/Code Review**：所有未提交改动（尤其 `routes.js` +58 行 `/api/graph/*` 段、`seed.js`、`ageGraph.js`）尚未走评审闸门，不能断言"已验收"。
- **⚠️ 技术债：对外端点功能重复（两线各出一套，此前未记）**——同源三对：
  - `/api/monitor/trace/:id`（routes.js:241） ↔ `/api/graph/trace?decisionId=`（:284）
  - `/api/monitor/impact/:id`（:248） ↔ `/api/graph/impact`（:296）
  - `/api/monitor/audit?decision_id=`（:252） ↔ `/api/graph/provenance?decision_id=`（:306）
  - 均调 `decisionTrace.traceDecision`/`getImpact`/`provenance.exportAudit`，仅路径风格不同。**后果**：对外契约二义、SKILL/前端可能各接一套、后续改动需双改易漂移。收敛须走 brainstorming 定主口径（倾向保留 `/api/graph/*` 统一只读查询面、`/api/monitor/*` 标 deprecated 转发），**未经批准不擅自删端点**。
- **计划文档滞后于代码**：`age-semantica-program.md` 的 §0「现状审计」及所有 Task checkbox 已过时（仍称"addDecision 未被调用/SHA-256 链未实现/无 CREATE EXTENSION 权限"），均已由线 A 落地或实证推翻（agent2b `rolsuper=true`，AGE 1.6.0 已装、`crm_decision_network` 图已存在）。**勿据 checkbox 误判"未开发"。**

---

## §3 所有任务都有测试报告？

- **测试齐备**：`test/` 共 **64 测试文件**（55 tracked + 11 untracked 新测试：age-bootstrap/age-causal/age-sync/conflict/dedup/graph-analytics/graph-rest/mcp-gateway/monitor-graph/provenance-chain/skills-methodology），**466 用例全绿**。新功能均有对应测试。
- **无聚合「测试报告」文档**：仅 vitest 运行时输出，没有 HTML/PDF 形式的汇总报告（如需可生成）。
- **覆盖缝隙**：
  - `/meta-attr-drawer` 路由本身**无专属 HTTP 测试**（抽屉 HTML 内容被 `meta-attr-page.test.js` 测，但路由服务行为未测）。
  - `crm-*/method-*` SKILL 是知识资产，经 `skills-methodology.test.js`（11/11）+ `mcp-gateway.test.js`（9/9）**间接覆盖**，无逐 SKILL 单测。

---

## §4 测试都通过了吗？

**是。** 实测命令：

```
cd D:\system\CRM-ai-native
PGHOST=127.0.0.1 PGPORT=5433 PGUSER=agent2b PGPASSWORD=agent2b PGDATABASE=plm PGSCHEMA=crm \
  node node_modules/vitest/vitest.mjs run
```

输出：
```
 Test Files  64 passed (64)
      Tests  466 passed (466)
   Duration  27.34s
```

- **0 失败**，含全部未提交改动（工作树即被测对象）。
- **退出码**：本轮实测 **= 0**。此前多次记录的"退出码 1（db.js 空闲池保活强退 worker）"本轮未复现，暂视为解除；如再现另记（属 teardown 副作用，非测试失败）。

---

## 给用户的下一步（按优先级）

1. **立即本地提交**：线 B（age-semantica-program）28/28 绿但 0 commit，丢失风险最高；建议分笔：`① AGE 程序 P0-P8（src/mcp + decision/* + web/decision-graph.html + 10 测试 + db/*.sql）`、`② skills-registry 修复（seed.js）`、`③ G1/G2/G3 收尾改动`。
2. **收敛端点重复债**：走 brainstorming 定 `/api/graph/*` vs `/api/monitor/*` 主口径，再动手，勿擅自删。
3. **验证两未决设计稿**：portal-home、particle-attr-ui-patch 是否需实现或归档。
4. **可选**：生成聚合测试报告（HTML/JSON）作为"测试报告" artifact。

> 注：`docs/2026-08-26-gap-inventory.md` 已过时，其 G1/G2/G3「未开发」结论与本审计冲突——以本审计（工作树实测）为准。
