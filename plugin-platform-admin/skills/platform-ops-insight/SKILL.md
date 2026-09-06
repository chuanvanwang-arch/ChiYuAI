---
name: platform-ops-insight
description: 平台管理员 / sysadmin 视角的「运营洞察」Runbook——租户套餐/用量/到期/缴费一览、智能体运作汇总（成败+原因）、决策健康（场景/结果/失单原因）、后台参数诊断报告（含处方建议与批准）、管理员待办审批。须 crm_login 登录验证 + 仅 sysadmin 角色可执。触发词：运营报告、运营诊断、租户套餐、用量、到期、缴费、智能体汇总、决策健康、参数报告、待办审批、sysadmin。
type: domain
immutable_baseline: true
related_skills:
  - user-rbac-admin        # 治理角色/权限同源
  - industry-onboarding    # 租户经营视角（套餐/到期）与行业上线衔接
---

# 平台运营洞察 Runbook（Platform Ops Insight）

## 0. 定位与边界

- 本 SKILL 管**平台运行可见性与治理**（读聚合 + 处方签批），与业务销售（crm-native）、行业上线（industry-onboarding）严格分离。
- 全部数据聚合为**只读**；唯一写 = 管理员待办签批（my-todo-approve / tune-approve，两阶段确认）。
- **准入双闸（缺一不可）**：① `crm_login(username,password)` 验证通过；② 角色 `sysadmin`。普通 admin / 其它角色 → 403。
- **红线**：`context-routing` 相关 knob **仅展示实验数据、不产处方**；绝对禁删；per-tenant 隔离（sysadmin 通配，租户管理员限本租户）。

## 1. 能力映射

| 用户意图 | 工具 | 说明 |
|---|---|---|
| "各租户套餐/用量/到期/缴费" | `admin-tenant-usage` | 套餐档位/状态/到期日/宽限/用量/周期 |
| "智能体运作汇总/失败原因" | `admin-agent-summary` | runs/done/failed/degraded + 失败原因归一 |
| "决策成败/失单原因" | `admin-decision-health` | 场景级 made/escalated + 结果分布 |
| "后台参数怎么调/诊断报告" | `admin-param-diagnosis` | 三段报告 + 处方 recommend |
| "批准参数调优/驳回" | `tune-approve` / `tune-reject` | 处方签批（两阶段） |
| "我的待办/待审批" | `my-todo-query`（view=approval/tuning） | 六视角待办 |
| "批准/驳回审批" | `my-todo-approve` / `my-todo-reject` | 审批签批（两阶段） |

## 2. 调用范式

**场景 A — 出运营诊断报告**
用户：「出个运营诊断报告」
→ ① `admin-agent-summary`（days=7）
→ ② `admin-decision-health`（days=30）
→ ③ `admin-param-diagnosis`（days=7）
→ 呈现三段报告 + red_lines 声明（context-routing 不产处方）+ patches 处方清单（附 recommend）。
→ 处方可接 `tune-approve`/`tune-reject`（phase1 表单 → phase2 confirm_token）。

**场景 B — 各租户经营**
用户：「各租户套餐/用量/到期/缴费情况」
→ `admin-tenant-usage` → 表格化呈现（套餐/状态/到期日/用量/缴费）。

**场景 C — 管理员待办审批**
用户：「我的待办」
→ `my-todo-query`（view=approval）→ 待审批列表。
→ `my-todo-approve`（task_id, instance_id, opinion）→ phase1 确认表单 → phase2 执行。

## 3. 红线与验收

| 红线 | 说明 |
|---|---|
| 双闸 | 登录验证 + sysadmin，缺一即拒 |
| context-routing 不产处方 | 诊断报告只展示实验数据，patches 过滤该族 |
| 两阶段写 | 签批写 phase1 表单 → phase2 confirm_token |
| 禁删 | 无 delete/remove 工具 |
| per-tenant | sysadmin 通配，租户管理员限本租户 |

验收：`admin-param-diagnosis` 报告含 red_lines；`my-todo-approve` 签批后任务状态变更；非 sysadmin 调 admin-* → 403。

## 4. 铁律声明

本 SKILL 是**领域专属**平台运营手册，与 10 大 ai-* 方法论能力 SKILL 无关、不交叉写入。通用方法论以交叉引用复用。
