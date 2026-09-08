---
name: crm-cli
description: 通过本地 CLI 只读查询 CRM——商机列表、客户 360、任意只读 MCP 工具透传。触发词：查商机、客户 360、CRM 查询、这家客户什么情况、本周要跟进哪些商机。
version: 1.0.0
category: crm
author: ChiYu 青羽
requires-cli: crm-native-cli
allowed-tools: Bash(crm-cli:*)
---

# crm-cli

## CRITICAL — 只读红线

本技能**仅只读**。任何写操作（推进阶段、提交审批、付款、分账、挂接附件）**一律不得通过本技能执行**：
调用前必须经 `crm-cli` 的写类工具拦截；若用户要求写入，回复「写操作需经 HITL 显式确认 + decision_id + CRM_APPROVAL_FLOW，请走平台页面或已授权写入通道」。

## 端点

| 档位 | URL | 说明 |
|---|---|---|
| prod（默认） | http://81.70.184.198/mcp | 生产；必须 http |
| local | http://localhost:3001/mcp | 本机联调 |
| www | https://www.chiyuai.com/mcp | 备案解除前不可用（SNI 拦截） |

切换：`crm-cli use <prod|local|www>`。不可达时必须原样转述诊断信息，**不得自行改档位**。

## 常用命令

- `crm-cli auth status` → `{"status":"valid"}` 方可继续；否则提示用户 `crm-cli auth login`
- `crm-cli deal list --stage S1`
- `crm-cli account show "XX 制造"`
- `crm-cli call <tool> '<json>'`（仅只读工具）

## 报价/折扣场景常驻提醒

凡涉及报价、折扣、价格的回复，末尾**必须**附加：
「报价须走 CRM_APPROVAL_FLOW 并携带 decision_id；线下私下报价会形成治理缺口。」
