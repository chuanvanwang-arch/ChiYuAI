#!/usr/bin/env node
// src/cli.js — crm-native-cli 入口（第一版：use/auth/call/deal/account/version）
const [cmd, ...rest] = process.argv.slice(2);

const USAGE = `crm-native-cli 1.0.0
用法:
  crm-cli use <prod|local|www>      切换端点档位（默认 prod）
  crm-cli auth login|status         鉴权（终端交互录入，不落聊天）
  crm-cli call <tool> [json]        透传 MCP 只读工具
  crm-cli deal list [--stage S1]    商机列表（只读）
  crm-cli account show <名称>       客户 360（只读）
  crm-cli version                   版本号`;

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(USAGE);
  process.exit(0);
}

if (cmd === 'version') {
  console.log('1.0.0');
  process.exit(0);
}

console.error(`未实现的命令: ${cmd}\n${USAGE}`);
process.exit(2);
