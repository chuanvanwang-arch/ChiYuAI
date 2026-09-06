// src/mcp/config.js — MCP Server 配置（对外分发层：stdio + StreamableHTTP 双传输）
// 设计输入：总体设计 §6.13（无头设计可嵌入：MCP Server + HTTP API 暴露）
//           mcp-pack-complete-plan 阶段2（端口 3001 /mcp，对齐 P2P 惯例）
export const MCP_CONFIG = {
  server: {
    name: 'crm-native-mcp',
    version: '1.0.0',
    description: 'CRM-ai-native 对外分发 MCP Server——读直连（第0闸读默认放行） / 写两阶段（action-confirm + 决策第0闸）',
  },
  transport: {
    stdio: { enabled: true },                    // MCP stdio 传输（本地/嵌入智能体）
    streamableHttp: {
      enabled: true,
      port: 3001,                                // 对齐 P2P 3001 /mcp 惯例（独立端口，不与 3000 冲突）
      path: '/mcp',
      cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] },
    },
  },
  security: {
    // 安全红线（§6.13 + CordysCRM 教训）：零信任 / 凭证隔离 / 绝对禁删 / 写前校验 / 最小权限降级 sales
    absoluteNoDelete: true,                       // 绝对禁删：不暴露任何 delete/remove 工具（registry 亦无）
    requireDecisionOnWrite: true,                // 写操作强制 decision_id（第0闸；无决策不写）
    writeTwoPhase: true,                          // 写两阶段：取表单→确认→执行→验证（action-confirm）
    readDefaultDirect: true,                      // 读默认直连（决策网络/粒子图检索之外的默认通道）
    minPrivilegeFallback: 'sales',               // requireAuth=false 时的回退；requireAuth=true 时不再降级放行
    requireAuth: true,                            // 外部智能体首次接入必须 crm_login 用户名密码验证（无凭证硬拒绝）
    tokenTtlMs: 8 * 60 * 60 * 1000,               // API token 有效期 8h（凭证隔离，短时有效）
  },
  apiToken: {
    // 平台颁发 token → actor 映射（真实场景：token 存服务端哈希，这里仅演示注入）
    // 零信任：客户端凭证永不直接进 Action ctx.actor，必须经 auth.resolveActor 解析
    demo: {
      actor: 'wangchuan',                          // demo 账号（对应 CRM_PERSON slug=wangchuan）
      role: 'sales',                               // 显式角色（最小权限演示；生产由 role-engine 自推断）
    },
  },
};