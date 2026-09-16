// src/mcp/tools.js — MCP 工具清单（Action Registry → MCP tools）
// 设计输入：总体设计 §6.13（对外无头暴露）+ mcp-pack-complete-plan 阶段2
// 安全红线：绝对禁删（无 delete/remove 工具）、读直连优选、写两阶段（gateway 签发 confirm_token）

import { listActions } from '../action/registry.js';
import { seedActions } from '../action/seed-actions.js';
import { seedDiscoveryActions } from '../action/discoveryActions.js';
import { seedConnectorActions } from '../connectors/connectorActions.js';
import { z } from 'zod';

// JSON Schema → Zod shape（MCP SDK 1.x 需要 zod raw shape；仅取 MCP 入参需要的字段）
// 同时支持扁平 seed schema（值=类型名字符串）与标准 {type,properties}（值=对象）。
export function jsonSchemaToZod(schema = {}) {
  const shape = {};
  const props = schema.properties || {};
  for (const [k, p] of Object.entries(props)) {
    // 扁平 seed schema：值本身就是类型名字符串（{customer_id:'string', payload:'object'}）；
    // 标准 JSON Schema：值是 {type, ...} 对象。先判 typeof，否则扁平 map 的 number/object/array
    // 会被 p.type(undefined) 降级成 string → MCP 侧 payload/rows 全期望 string、被 SDK 剥离。
    const t = typeof p === 'string' ? p : (p.type || 'string');
    let zodType;
    switch (t) {
      case 'string': zodType = z.string(); break;
      case 'number': zodType = z.number(); break;
      case 'integer': zodType = z.number().int(); break;
      case 'boolean': zodType = z.boolean(); break;
      case 'array': zodType = z.array(z.any()); break;
      case 'object': zodType = z.record(z.any()); break;
      default: zodType = z.any(); break;
    }
    shape[k] = zodType.optional(); // MCP 工具宽松：必填校验留给 gateway/闸
  }
  return shape;
}

// 构建工具清单：读直连（4 个通用读）+ 业务写（两阶段，gateway 接管）
// 修复（2026-08-26 14:3x，SDK 冒烟暴露）：
//   seed 的 schema 是「扁平 map」（{ customer_id:'string' }）而非 {type,properties}，
//   旧代码取 a.schema?.properties → 恒 {} → zod shape 空 → SDK strip 全部参数，
//   confirm_token/choice/decision_id 永远到不了 gateway（真实 MCP 下第0闸/confirm 假阴性）。
//   调用方统一 jsonSchemaToZod({type:'object', properties: a.schema})，循环体（L14）对扁平
//   map 值做 typeof==='string' 类型推断；标准 {type,properties} 对象仍走 p.type 分支（2026-09-03 修正）。
export function buildMcpTools({ seed = true } = {}) {
  // 2026-09-11 修复（T19 派发前复查发现）：`seedActions()` **不含** discovery 族注册
  //   （discovery-* 由独立的 `seedDiscoveryActions()` 注册；应用进程经 `agents.js:70` /
  //   `routes.js:495` 注册，但 **`src/mcp/server.js` 只 import buildMcpTools → 二者都不会执行**）。
  //   后果：独立 MCP 进程（`npm run mcp:http|stdio`）里 discovery-run/enrich/research **从未注册**
  //   → 工具面看不到（真实暴露 57 而非 60）、buddy 胶囊 `skill:'discovery-run'` 派发失败；
  //   而 T18 单测因在 beforeAll 显式 seed 了 discovery 族 → 断言仍绿 = 典型「假绿」。
  //   buildMcpTools 是 MCP 暴露面的唯一咽喉 → 在此一并注册，一处修复覆盖 server.js / 校验脚本 / 探针。
  // 2026-09-16 P0-4 修复（F4 第三次复发）：`seedActions()` 与 `seedDiscoveryActions()` 均不含
  //   connector 族（`conn-*` 与 `sync-writeback-fields` 由 `seedConnectorActions()` 注册，此前仅
  //   app 进程 `routes.js:616` 调用）→ 独立 MCP 进程（`npm run mcp:http|stdio`；生产 /mcp）
  //   工具面无 `sync-writeback-fields`，「办公智能体经 MCP 交互后回写」链路永久断。
  //   buildMcpTools 是 MCP 暴露面唯一咽喉 → 三族在此一并注册，一处修复覆盖 server.js / 校验脚本 / 探针。
  if (seed) { seedActions(); seedDiscoveryActions(); seedConnectorActions(); }
  // 2026-09-03 方案 A（用户拍板）：MCP 暴露面按 lifecycle 收敛——隐藏 `reserved` 死表面，
  // 仅暴露 active(默认) + engine。注册表全量保留（遵守禁 DELETE 铁律，只收暴露层、不删 action）。
  const all = listActions().filter((a) => a.lifecycle !== 'reserved');

  // 2026-09-03 C 方案接线：lifecycle 标签（MCP 描述前缀，供客户端识别 action 真实调用状态）
  // active(默认)=运行系统调用；engine=引擎内部触发（审批流/校准/决策/agent/method）；
  // reserved=注册暴露但暂未接线（死表面降级，不物理删）。
  const LIFECYCLE_TAG = { engine: '[引擎]', reserved: '[reserved]' };
  const lcTag = (a) => LIFECYCLE_TAG[a?.lifecycle] || (a?.namespace === 'method' ? '[引擎]' : '');
  const readTools = [];
  const writeTools = [];

  // 协议附加字段：confirm 两阶段 + 凭证 用（非业务参数，必显式加入 zod shape 防 strip）
  // decision_id 为写通道第 0 闸必需（gateway.js mcpWritePhase1:59 校验 ctx.decision_id），
  // api_token 为 extractToken 第一优先凭证源（src/mcp/auth.js:65），二者均须显式声明，
  // 否则 SDK 按 schema strip 掉 → 前者网关收不到决策（假阴性「无决策不写」），
  // 后者真实 MCP 下办公智能体用 api_token 参数传凭证会被静默剥离 → auth_required 假阴性。
  // 2026-09-01 修复：补 api_token（confirm_token/choice/decision_id 同款 SDK strip 陷阱，
  // 见本文件 §顶部 2026-08-26 修复注释，当时漏了 api_token）。
  const protocolShape = {
    confirm_token: z.string().optional(),
    choice: z.string().optional(),
    decision_id: z.string().optional(),
    api_token: z.string().optional(),
    // 2026-09-08 对话驱动决策建议（T6）：销售诉求原文。同 api_token 的 strip 陷阱——
    //   未在此声明则被 zod 剥离，gateway 永远收不到 utterance。声明后由 gateway 取出并
    //   立即从 params 删除（D2：对话原文零落库，不得随写参数进粒子 payload）。
    utterance: z.string().optional(),
    // 2026-09-09 第 0 闸/第 2 闸确认位：`force` 是高危写（def.force===true，如 data-particle-update /
    //   crm-import-batch）的显式确认位，属**协议级**参数而非业务参数，不出现在 Action 的扁平 schema 中。
    //   未在此声明 → 被 z.object 剥离 → gateway 永远收不到 → 第 2 闸恒报「需 force=true」，
    //   高危写经 MCP 永久不可用（与 api_token / utterance 同一 strip 陷阱，第三次踩）。
    force: z.boolean().optional(),
  };

  // 读直连：Action Registry 中 kind=read 的全部暴露（data-particle-read 等）
  for (const a of all) {
    if (a.kind === 'read') {
      readTools.push({
        name: a.name,
        kind: 'read',
        description: lcTag(a) + (a.description || `读取 ${a.name}`),
        inputSchema: { ...jsonSchemaToZod({ type: 'object', properties: a.schema || {} }), ...protocolShape },
      });
    }
  }

  // 业务写（两阶段，gateway 发 confirm_token）
  // 2026-09-04：data-* substrate 写族默认不上 MCP（沿用 2026-09-03 暴露面收敛，防任意类型粒子
  //   创建面过宽）；仅当 Action 显式声明 mcpExpose===true 才单点 opt-in 放开。
  //   首个放行动作：data-particle-create（销售/AI 经 MCP 建客户、商机、合同等主数据）。
  const isExposedWrite = (a) => a.kind === 'write' && (!a.name.startsWith('data-') || a.mcpExpose === true);
  for (const a of all) {
    if (isExposedWrite(a)) {
      writeTools.push({
        name: a.name,
        kind: 'write',
        description: lcTag(a) + ((a.description || `写入 ${a.name}`) + ' [两阶段: 先取表单确认，再执行]'),
        inputSchema: { ...jsonSchemaToZod({ type: 'object', properties: a.schema || {} }), ...protocolShape },
      });
    }
  }

  // 敏感读（read_sensitive）：经 gateway confirm 闸，不直接 dispatch（§6.13 角色确认 + 5 类敏感读边界）
  const readSensitiveTools = [];
  for (const a of all) {
    if (a.kind === 'read_sensitive') {
      readSensitiveTools.push({
        name: a.name,
        kind: 'read_sensitive',
        description: lcTag(a) + ((a.description || `敏感读 ${a.name}`) + ' [需确认: 角色确认后执行]'),
        inputSchema: { ...jsonSchemaToZod({ type: 'object', properties: a.schema || {} }), ...protocolShape },
      });
    }
  }

  // 登录工具（不在 Action Registry；免 token 即可调用，作为首次接入验证入口）
  const authTools = [
    {
      name: 'crm_login',
      kind: 'auth',
      description: '首次接入验证：用户名 + 密码 → 返回 MCP 接入 token；之后调用携带该 token',
      inputSchema: { username: z.string(), password: z.string() },
    },
  ];

  return { tools: [...readTools, ...writeTools, ...readSensitiveTools, ...authTools], readTools, writeTools, readSensitiveTools, authTools };
}

export function listMcpTools() {
  return buildMcpTools({ seed: true });
}