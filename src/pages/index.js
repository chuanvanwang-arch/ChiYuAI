// src/pages/index.js — 33 受控面注册入口（按 Phase 分段 import，各 Phase 任务递增补全）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md（Phase 1-4 逐面 Task）
// 契约：每个面 = <id>.schema.js 导出 schema 对象 → registerPage(id, schema)（validator 强校验）
import { registerPage } from './registry.js';

// Phase 1：骨架面（S01/S02/S13/S14/S15/S25）——schema 由各 Task 提供
import { schema as S01 } from './S01.schema.js';
import { schema as S02 } from './S02.schema.js';
import { schema as S13 } from './S13.schema.js';
import { schema as S14 } from './S14.schema.js';
import { schema as S15 } from './S15.schema.js';
import { schema as S25 } from './S25.schema.js';

registerPage('S01', S01);
registerPage('S02', S02);
registerPage('S13', S13);
registerPage('S14', S14);
registerPage('S15', S15);
registerPage('S25', S25);

// Phase 2：前台业务详情补全（S03-S12）——schema 由各 Task 提供
import { schema as S03 } from './S03.schema.js';
import { schema as S04 } from './S04.schema.js';
import { schema as S05 } from './S05.schema.js';
import { schema as S06 } from './S06.schema.js';
import { schema as S07 } from './S07.schema.js';
import { schema as S08 } from './S08.schema.js';
import { schema as S09 } from './S09.schema.js';
import { schema as S10 } from './S10.schema.js';
import { schema as S11 } from './S11.schema.js';
import { schema as S12 } from './S12.schema.js';

registerPage('S03', S03);
registerPage('S04', S04);
registerPage('S05', S05);
registerPage('S06', S06);
registerPage('S07', S07);
registerPage('S08', S08);
registerPage('S09', S09);
registerPage('S10', S10);
registerPage('S11', S11);
registerPage('S12', S12);

// Phase 3：配置中心面（S16-S33，按 G2→G3→G4→G1 优先级分批注册）
// G1 平台与访问：S16 LLM / S17 用户 / S18 RBAC / S32 连接器
// G2 销售方法论与决策治理：S19 决策场景 / S20 七维设计★ / S21 方法论注册表 / S24 元模型★ / S30 决策质量 / S31 记忆先例
// G3 业务对象与流程建模：S22 审批流 / S23 业务分级 / S26 预警 / S27 本体 / S28 智能体 / S29 门户页面
import { schema as S16 } from './S16.schema.js';
import { schema as S17 } from './S17.schema.js';
import { schema as S18 } from './S18.schema.js';
import { schema as S19 } from './S19.schema.js';
import { schema as S20 } from './S20.schema.js';
import { schema as S21 } from './S21.schema.js';
import { schema as S22 } from './S22.schema.js';
import { schema as S23 } from './S23.schema.js';
import { schema as S24 } from './S24.schema.js';
import { schema as S26 } from './S26.schema.js';
import { schema as S27 } from './S27.schema.js';
import { schema as S28 } from './S28.schema.js';
import { schema as S29 } from './S29.schema.js';
import { schema as S30 } from './S30.schema.js';
import { schema as S31 } from './S31.schema.js';
import { schema as S32 } from './S32.schema.js';

registerPage('S16', S16);
registerPage('S17', S17);
registerPage('S18', S18);
registerPage('S19', S19);
registerPage('S20', S20);
registerPage('S21', S21);
registerPage('S22', S22);
registerPage('S23', S23);
registerPage('S24', S24);
registerPage('S26', S26);
registerPage('S27', S27);
registerPage('S28', S28);
registerPage('S29', S29);
registerPage('S30', S30);
registerPage('S31', S31);
registerPage('S32', S32);

// S33 待办工作台（/todo）：四视角成品页 schema（08 门户 §5），注册入受控面表
import { schema as S33 } from './S33-workbench.schema.js';
registerPage('S33', S33);

// S36 漏斗质量看板（/funnel-quality）：受控页签（设计 2026-08-30 funnel-design §5.3），
// 替代原自由 HTML 直连 /api/funnel/* 的写法（页面经 renderPage 唯一出口出片）
import { schema as S36 } from './S36.schema.js';
registerPage('S36', S36);