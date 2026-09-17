// src/portal/configCenter.js — 配置中心统一入口渲染器（纯函数，浏览器 + vitest 共用）
// 设计：2026-08-27-config-center.md；仅聚合 + 只读视图，不做各配置项 CRUD 编辑器
// 复用范式：agentsPage.js / detailSections.js（PORTAL 目录 ESM，node 环境可直接测）
// §15 权限重分组（2026-09-04）：每项新增 level 字段（'system'=仅 ADMIN / 'tenant'=ten_admin+sysadmin+ADMIN）。
//   注意：level（权限层级）与 scope（数据存储作用域 platform/tenant）语义不同，但同一配置项二者通常一致——
//   如 id12 用户管理 scope='tenant' 且 level='tenant'（sysadmin 可管理本/跨租户用户，设计 §15.2，2026-09-06 收口）。

// 24 项配置清单（id 11–35，25 已删不重用；33 原为边绑定占位已删除、后以「思维要素总览」功能恢复、35 为事件触发复盘；sRef 对齐 master-blueprint §3 页面编号 S*，仅 schema 页有值）
// status: 'ready'(已有 UI 页) | 'readable'(有 GET 端点可即时读) | 'pending'(待建设)
// 数组按组连续排列（对齐蓝图 §1.1 G1–G4：平台与访问 / 销售方法论与决策治理 / 业务对象与流程建模 / 智能体与运行），组内 id 升序
export const CONFIG_ITEMS = [
  { id: 11, sRef: 'S16', name: 'LLM 配置', group: '平台与访问', level: 'system', status: 'ready', page: '/llm.html', endpoint: '/api/config/llm', scope: 'platform', resolve: 'system-only', note: 'provider/model/temp 编辑，写经决策第0闸+sysadmin；平台级：恒读/写 (system,llm)，不租户隔离' },
  { id: 12, name: '用户管理', group: '平台与访问', level: 'tenant', status: 'ready', page: '/users.html', endpoint: '/api/config/users', scope: 'tenant', resolve: 'tenant-first', note: '增/改/禁用(禁删)，密码 crypt hash，sysadmin 权限，写经决策第0闸' },
  { id: 13, name: '权限 / RBAC 矩阵', group: '平台与访问', level: 'system', status: 'ready', page: '/rbac.html', endpoint: '/api/rbac', scope: 'platform', resolve: 'system-only', note: '角色×数据范围矩阵（data_scope），引擎自动消费（平台级声明，RBAC 无租户粒度）' },
  { id: 27, name: '连接器 / MCP 配置', group: '平台与访问', level: 'system', status: 'ready', page: '/mcp-identities.html', endpoint: '/api/mcp-identities', scope: 'platform', resolve: 'system-only', note: 'crm.mcp_identity 身份绑定，零信任 token 哈希（平台级声明：身份绑定不走租户隔离）' },
  { id: 28, name: '系统设置', group: '平台与访问', level: 'system', status: 'ready', page: '/system.html', endpoint: '/api/config/system', scope: 'platform', resolve: 'system-only', note: '站点名/主题/会话超时/安全策略，写经决策第0闸+sysadmin，审计日志直查 decision_event（平台级声明）' },
  // G1 平台级管理面（2026-09-04 新增）：租户与套餐均为平台级声明（system-only），普通租户不可见
  { id: 40, name: '租户管理', group: '平台与访问', level: 'system', status: 'ready', page: '/admin-billing-console.html#subs', endpoint: '/api/tenants', scope: 'platform', resolve: 'system-only', note: '深链复用 admin-billing-console「租户订阅」tab（只读订阅全景）；新建租户走 industry-onboarding 智能体（POST /api/tenants），禁物理删' },
  { id: 41, name: '平台套餐管理', group: '平台与访问', level: 'system', status: 'ready', page: '/admin-billing-console.html#plans', endpoint: '/api/admin/billing-plans', scope: 'platform', resolve: 'system-only', note: '深链复用 admin-billing-console「套餐管理」tab（套餐维护软停用+计费设置）；写经 /api/admin/billing-plans，禁物理删。endpoint 指向 admin 写端点：GET /api/billing/plans 须公开只读（landing.html 匿名动态同步依赖），若登记到注册表闸会把匿名访客/sales 拦成 401（2026-09-06 修复）' },
  // 传播中枢 UI 入口（2026-09-05）：系统配置→租户成批复用（broadcast）+ 租户经验上行推广（promote）。
  // 后端已就绪：src/http/propagationRoutes.js 4 个 API（写经决策第0闸；上下贯通强制 ADMIN，§15.5）；页面深链复用既有 propagation-hub.html。
  // 传播中枢 UI 入口（2026-09-05→2026-09-06 收口）：config-center UI 闸已 ADMIN-only
  // （LEVEL_ROLE_MAP propagation→ADMIN / LEVEL_GROUPS propagation roles=[ADMIN]）；
  // 写 API 经 gateAccept 收紧（跨租户/系统级记忆推广仅 ADMIN，见 §3.2）。
  //   「保持原值不动」待裁决项已关闭（2026-09-06 复勘确认 UI 闸 + 写 API 均已 ADMIN-only）。
  { id: 42, name: '全局复用与经验蔓延', group: '平台与访问', level: 'propagation', status: 'ready', page: '/propagation-hub.html', endpoint: '/api/propagation/suggestions', scope: 'platform', resolve: 'system-only', note: '系统配置向租户成批复用（强制下发 fill-only/override）+ 租户经验上行推广（复盘候选采纳/记忆→租户先例）；写经决策第0闸，上下贯通仅 ADMIN，禁删只增改' },
  { id: 14, sRef: 'S19', name: '销售决策场景配置', group: '销售方法论与决策治理', level: 'tenant', status: 'ready', page: '/decision-scenarios.html', endpoint: '/api/decision-scenarios', scope: 'tenant', resolve: 'tenant-first', note: '8 场景可编辑（描述/方法论/评估维/默认分级/自主开关/处置集/聚焦尺子/及格线/启用尺子子集），写经决策第0闸' },
  { id: 15, name: '七维设计', group: '销售方法论与决策治理', level: 'tenant', status: 'ready', page: '/seven-dim.html', endpoint: '/api/config/seven-dim', scope: 'tenant', resolve: 'tenant-first', note: '七维评估维度 0–5 编辑（scene-quote 拦截依赖）；消费方读按租户（T5），写侧仍落 system 基线' },
  { id: 16, sRef: 'S21', name: '方法论 SKILL 注册表', group: '销售方法论与决策治理', level: 'system', status: 'ready', page: '/skills.html', endpoint: '/api/config/skill-registry', scope: 'platform', resolve: 'system-only', note: '11 SKILL 启停开关编辑（DB 持久化，写经决策第0闸+sysadmin，禁删只改 enabled；平台级声明）' },
  { id: 17, name: '审批流配置', group: '业务对象与流程建模', level: 'tenant', status: 'ready', page: '/approval-flow.html', endpoint: '/api/approval-flows', scope: 'platform', resolve: 'system-only', note: '四域审批流定义（deal/quote/contract/invoice），平台级共享模板（全租户共用拓扑，方案 α 2026-09-06 标签校正：实际隔离在数据层保障，scope 由 tenant 改 platform），写经决策第0闸' },
  { id: 18, name: '业务分级配置', group: '业务对象与流程建模', level: 'tenant', status: 'ready', page: '/business-tier.html', endpoint: '/api/business-tier-config', scope: 'tenant', resolve: 'tenant-first', note: 'DEAL=客户维×项目维，驱动自主边界' },
  { id: 19, name: '粒子属性 Schema 配置', group: '系统日志', level: 'system', status: 'ready', page: '/meta-attr-drawer', endpoint: null, scope: 'platform', resolve: 'system-only', note: '粒子字段级属性 Schema 受控抽屉（meta_attr）；纯显示只读参考（编辑未接线，过第0闸的 data-particle-attr-update 未启用），系统级；与 #22 业务词汇区分' },
  { id: 20, sRef: 'S25', name: '池配置', group: '业务对象与流程建模', level: 'tenant', status: 'ready', page: '/pool-config.html', endpoint: '/api/pool-config', scope: 'tenant', resolve: 'tenant-first', note: 'pick/recycle 规则编辑，setPoolConfig 持久化' },
  { id: 21, name: '预警规则配置', group: '智能体与运行', level: 'tenant', status: 'ready', page: '/alert-rules.html', endpoint: '/api/alert-rules', scope: 'tenant', resolve: 'tenant-first', note: '6 类规则启停+阈值编辑（含指名应访逾期），写经决策第0闸，DB 持久化' },
  { id: 22, name: '业务词汇配置', group: '业务对象与流程建模', level: 'tenant', status: 'ready', page: '/ontology.html', endpoint: '/api/config/ontology/vocabulary', scope: 'tenant', resolve: 'tenant-first', note: '业务词汇（CRM_KNOWLEDGE 粒子，写时同源登记）可编辑部分：增/改/软停用经决策第0闸+租户级角色，按 tenant_id 隔离（admin 通配全量），禁删=软停用。本项仅承载「可编辑词汇」——粒子本体只读总览已拆出至系统级 #45（2026-09-05 用户决议：词汇是租户主数据，留租户级）。endpoint 指向真实挂载的 /vocabulary 子路径（基路径 /api/config/ontology 非 GET 处理函数）' },
  { id: 23, sRef: 'S28', name: '智能体配置', group: '智能体与运行', level: 'system', status: 'ready', page: '/agent-config.html', endpoint: '/api/agent-config', scope: 'platform', resolve: 'system-only', note: '3 Agent 六段式定义只读视图+装配断言状态，数据源 agentSpec 代码层（平台级声明）' },
  { id: 24, name: '门户 / 页面生成配置', group: '系统日志', level: 'system', status: 'ready', page: '/page-market', endpoint: null, scope: 'platform', resolve: 'system-only', note: 'page schema / NL 模板浏览画廊（纯显示，系统级参考）' },
  { id: 26, sRef: 'S31', name: '记忆 / 先例管理', group: '系统日志', level: 'system', status: 'ready', page: '/memory.html', endpoint: '/api/memory', scope: 'tenant', resolve: 'tenant-first', note: '记忆三构件（日志/笔记/快照）只读总览 + 先例网络（纯显示；蒸馏标记经决策第0闸，非编辑）；系统级（仅 ADMIN），§15 闸对 /api/memory 收紧为 ADMIN' },
  // S05 T5：财务应收配置（逾期天数/差额阈值/账龄分档，写经决策第0闸+sysadmin）
  { id: 29, name: '财务应收配置', group: '业务对象与流程建模', level: 'tenant', status: 'ready', page: '/finance-receivables.html', endpoint: '/api/config/finance-receivables', scope: 'tenant', resolve: 'tenant-first', note: '逾期天数/差额阈值/账龄分档，config_store 承载' },
  // S13：指名客户目标指标配置（tier × 频率 × 窗口 × 监测维度，仿 id 29 范式；消费方=account-360 与 named-accounts）
  { id: 30, name: '指名客户目标指标配置', group: '业务对象与流程建模', level: 'tenant', status: 'ready', page: '/named-account-targets.html', endpoint: '/api/config/named-account-targets', scope: 'tenant', resolve: 'tenant-first', note: '客户分级（重点/目标/潜力）× 拜访频率目标 × 窗口天数，config_store 承载，写经决策第0闸' },
  // S-method-behavior-standard：销售行为标准配置（量化目标：每天拜访次数/每周新客户数 + 21 条合格线清单展示；写经决策第0闸+admin）
  { id: 31, name: '销售行为标准配置', group: '销售方法论与决策治理', level: 'tenant', status: 'ready', page: '/behavior-standard-config.html', endpoint: '/api/config/behavior-standard', scope: 'tenant', resolve: 'tenant-first', note: '量化目标（每天拜访次数/每周拜访客户数/每周新客户数/每天电话量）公开给销售对比；21 条行为合格线清单只读展示，config_store 承载，写经决策第0闸+admin' },
  // 判定阈值：BANTCC 达标线 / 接触窗口 / 阶段停留 / 合格率线等业务阈值的唯一事实源。
  // 原则（2026-08-30 用户明确）：业务数值不得硬编码在 SKILL 或代码中，客户须能按需调整。
  { id: 32, name: '判定阈值', group: '销售方法论与决策治理', level: 'tenant', status: 'ready', page: '/sales-thresholds-config.html', endpoint: '/api/config/sales-thresholds', scope: 'tenant', resolve: 'tenant-first', note: 'BANTCC 达标线、近期拜访天数、接触窗口、阶段停留天数、S1→S2 需求项数、合格率着色线、指名应访黄红天数等；config_store 承载，写经决策第0闸+admin，越界 400' },
  { id: 33, name: '销售决策思维要素（8要素×九尺子）', group: '销售方法论与决策治理', level: 'system', status: 'ready', page: '/decision-thinking.html', endpoint: '/api/decision/thinking-templates', scope: 'platform', resolve: 'system-only', note: '8 大决策各自八要素提问×九尺子评分键总览（方法论层，代码版化自 thinkingTemplates.js，只读；平台级声明）' },
  // ③ 事件触发式复盘（2026-09-01）：决策确认即自动建复盘待办；触发分级/冷却窗后台可配，代码零硬编码。
  { id: 35, name: '事件触发复盘配置', group: '销售方法论与决策治理', level: 'system', status: 'ready', page: '/event-retro-config.html', endpoint: '/api/config/event-retro', scope: 'platform', resolve: 'system-only', note: '总开关、触发下限分级（NORMAL/HIGH/CRITICAL）、冷却窗小时数、建单后是否立即派发；决策确认后自动为复盘智能体建待办，config_store 承载，写经决策第0闸+sysadmin' },
  // ④ 夜间批量复盘（2026-09-05 R3 登记）：原 retro.js 读 config_store['decision-retro'] 但从未落库 → 配置恒走代码兜底（死代码）。
  //   现统一为 RETRO_CONFIG_KEY='decision-retro'，阈值全部可配（min_sample/llm_timeout_ms/window_extend_*/total_deadline_ms/llm_fail_circuit），
  //   读经 readRetroConfig() 合并出厂默认，写经 /api/config/decision-retro（决策第0闸+sysadmin）；系统级仅 ADMIN（§15）。
  { id: 43, name: '夜间批量复盘配置', group: '销售方法论与决策治理', level: 'system', status: 'ready', page: '/nightly-retro-config.html', endpoint: '/api/config/decision-retro', scope: 'platform', resolve: 'system-only', note: 'min_sample（簇样本阈值，真实日产量个位数时需下调或开扩窗）、llm_timeout_ms（DeepSeek-V4-Flash 推理超时）、window_extend_enabled/window_extend_hours（样本不足扩窗至 7d）、total_deadline_ms（夜批总时长预算）、llm_fail_circuit（连续失败熔断）；config_store 键 decision-retro，写经决策第0闸+sysadmin' },
  // 审批业务参数后台化（铁律 2026-08-31）：R1-R4 规则/金额档位/角色链/默认兜底统一进 config_store['approval-config']，
  //   与 id17 审批流拓扑（CRM_APPROVAL_* 粒子）分层——本项管「业务参数」，id17 管「拓扑节点」。
  { id: 34, name: '审批业务参数', group: '业务对象与流程建模', level: 'tenant', status: 'ready', page: '/approval-config.html', endpoint: '/api/config/approval-config', scope: 'tenant', resolve: 'tenant-first', note: 'R1-R4 规则、金额档位阈值(¥100万/¥500万)、各档角色链、重大项目强制 T3、无规则默认兜底；config_store 承载，写经决策第0闸+sysadmin' },
  // 场景路由（故事线/图谱/结构化）后台化（融合设计批准 2026-09-02）：dims/scene_matrix/thresholds 出厂默认在 src/context/routing.js，
  //   管理员可调整任一场景的轨道（narrative/graph_decision/graph_entity/structured）与维度权重/阈值——不碰代码即改「哪个场景走什么」。
  { id: 36, name: '场景路由（故事线/图谱）', group: '销售方法论与决策治理', level: 'system', status: 'ready', page: '/decision-route-config.html', endpoint: '/api/config/context-routing', scope: 'platform', resolve: 'system-only', note: '12+ 场景×轨道画像（narrative/graph_decision/graph_entity/structured × L1-L4）经 config_store 承载；写经决策第0闸+sysadmin，缺省回退全轨；禁改红线：任何修改须用户显式批准（仅标签元数据修正，不碰 context-routing 配置与 routing.js）' },
  // C2 审计链巡检（2026-09-03，配置中心 id37）：把 verifyChain 从「仅审计导出时触发」升级为「写时自检 + 定时全量巡检 + 封印比对」。
  //   间隔/批次走 config_store['provenance-patrol']（阈值配置化铁律，代码仅存出厂默认值）；封印补哈希链「删链尾不可检出」的固有盲区。
  { id: 37, name: '审计链巡检', group: '销售方法论与决策治理', level: 'system', status: 'ready', page: '/decision-provenance-patrol-config.html', endpoint: '/api/config/provenance-patrol', scope: 'platform', resolve: 'system-only', note: '巡检间隔 interval_ms（默认 3600000）与单批 limit（默认 200）；配置值平台级（巡检器读 system），巡检执行按租户循环（T11）——两义不矛盾；告警落 monitor_event；config_store 承载，写经决策第0闸+sysadmin' },
  { id: 38, name: '先例检索（C4 四分量）', group: '销售方法论与决策治理', level: 'tenant', status: 'ready', page: '/decision-precedent-config.html', endpoint: '/api/config/precedent-conf', scope: 'tenant', resolve: 'tenant-first', note: '先例相似度四分量权重(jaccard 0.4/category 0.2/graphDepth 0.2/vector 0.2)与阈值(minSimilarity 默认 0.45)；向量不可用自动降级，config_store 承载，写经决策第0闸+sysadmin' },
  { id: 39, name: '事件触发智能体派发', group: '智能体与运行', level: 'system', status: 'ready', page: '/agent-event-trigger-config.html', endpoint: '/api/config/agent-event-trigger', scope: 'platform', resolve: 'system-only', note: '订阅 ontology-sync 事件，按矩阵自动为 quote-engine/followup-agent/decision-agent 建只读判定任务；三级防风暴（DB去重+内存冷却+只读白名单）；config_store 承载，写经决策第0闸+sysadmin，删键回退出厂默认' },
  // 场景路由 A/B 实验（2026-09-05 P1 注册）：routingExperiment.js/assembler.js 消费的 config_store['routing-explore']
  //   出厂兜底 window_days=14/max_running=2/blacklist/min_arm_sample=20（routingExperiment.js:20-25），可覆盖；
  //   时间片轮换只在装配期做运行时覆盖，配置原值一字不动；结论只出 calibration_patch PENDING 处方，人工批准+第0闸后才写。
  { id: 44, name: '路由实验（routing-explore）', group: '销售方法论与决策治理', level: 'system', status: 'ready', page: '/decision-route-config.html', endpoint: '/api/config/routing-explore', scope: 'platform', resolve: 'system-only', note: '场景路由时间片 A/B 实验参数（window_days/max_running/blacklist/min_arm_sample/daily_review_enabled）；config_store 承载，写经决策第0闸+sysadmin；红线：只出 PENDING 处方，不自动改 context-routing' },
  // ⑤ 粒子本体只读总览（2026-09-05 拆分 id22：可编辑「业务词汇」留租户级 #22，只读「本体快照」升系统级——纯显示、与词汇按租户隔离原则一致）
  { id: 45, name: '粒子本体总览（只读）', group: '系统日志', level: 'system', status: 'ready', page: '/ontology.html', endpoint: null, scope: 'platform', resolve: 'system-only', note: '粒子实体/关系本体只读快照（代码常量事实源，与 #22 业务词汇分离）；纯显示，系统级' },
  // 线索发现规则（2026-09-10）：ICP / 数据源三档 / 信号权重 / 查重条件 / 编排 playbooks；租户级
  { id: 46, name: '线索发现规则', group: '智能体与运行', level: 'tenant', status: 'ready', page: '/discovery-rules.html', endpoint: '/api/config/discovery-rules', scope: 'tenant', resolve: 'tenant-first', note: 'ICP（行业/规模/地域/置信下限）、数据源三档（system/system-candidate/paid，付费源出厂 enabled:false 需显式授权）、信号权重、查重条件 duplicate_criteria（配置驱动，对齐 Twenty flatObjectMetadata.duplicateCriteria）、编排 playbooks（data→condition→ai→action）；config_store 承载，写经决策第0闸' },
  // 外部数据接入（2026-09-14）：租户自有系统实例声明 + 加密凭据库（platform/system 级闸，sales 访问 403）
  { id: 47, name: '接入数据源（租户实例）', group: '智能体与运行', level: 'system', status: 'ready', page: '/discovery-rules.html#integration-sources', endpoint: '/api/config/integration-providers', scope: 'platform', resolve: 'system-only', note: '租户声明的自有系统实例（generic-rest/mcp/cli + field_map）；平台级声明，写经决策第0闸' },
  { id: 48, name: '接入凭据库（加密）', group: '智能体与运行', level: 'system', status: 'ready', page: '/discovery-rules.html#integration-sources', endpoint: '/api/integration/secret', scope: 'platform', resolve: 'system-only', note: 'per-tenant pgcrypto 加密凭据；写经专用加密端点（禁明文落库），读返回脱敏；平台级仅 ADMIN' },
  // 信号规则后台化（2026-09-17 前台可见性审计）：两键早已播种（Plan A 时间/周期规则、Plan B 内部异动派生），
  //   但配置中心零位点 → 只能改库、不能改界面。此二项把「信号规则」纳入后台可配（读写经通用工厂
  //   createConfigRouter，写经决策第0闸+sysadmin）。scope=tenant：规则按租户差分，读回退 system 模板。
  { id: 49, name: '信号时间规则配置', group: '智能体与运行', level: 'tenant', status: 'ready', page: '/signal-config.html', endpoint: '/api/config/signal-schedule', scope: 'tenant', resolve: 'tenant-first', note: '时间型/周期型信号规则（tender_deadline 投标截止临近 / report_due 周期报告 / quote_approval_timeout / stage_silence）启停、严重度、窗口与阈值编辑；config_store 键 signal-schedule，写经决策第0闸+sysadmin' },
  { id: 50, name: '内部异动派生配置', group: '智能体与运行', level: 'tenant', status: 'ready', page: '/signal-config.html', endpoint: '/api/config/internal-signal-derivation', scope: 'tenant', resolve: 'tenant-first', note: '内部推断信号规则（contact_change 联系人资料变动 / relation_cooling 客户关系冷却）启停、窗口与停滞阈值编辑；低置信 internal_inference，权重严格低于实测情报；config_store 键 internal-signal-derivation，写经决策第0闸+sysadmin' },
];

const GROUP_ORDER = ['平台与访问', '销售方法论与决策治理', '业务对象与流程建模', '智能体与运行', '系统日志'];

// §15.2 一级分组（roles 仅作后端闸文档化，不渲染进 UI——菜单是导航不是权限声明，2026-09-05 用户决议）
// 角色名 canonical=ten_admin（对齐 userManagement.js ROLE_TAGS 真实落库）；rbac.js ALIAS 已归一 tan_admin/ten_admin/tenant-admin 变体
export const LEVEL_GROUPS = [
  { level: 'system', name: '系统级', roles: ['ADMIN'] },
  { level: 'tenant', name: '租户级', roles: ['ten_admin', 'sysadmin', 'ADMIN'] },
  // 第三一级分组（2026-09-05）：传播中枢专属 TAB，仅 ADMIN 可见（上下贯通语义）
  { level: 'propagation', name: '全局复用与经验蔓延', roles: ['ADMIN'] },
];

const STATUS_BADGE = {
  ready: { icon: '✅', label: '已就绪', cls: 'ok' },
  readable: { icon: '🔵', label: '可读取', cls: 'read' },
  pending: { icon: '⚪', label: '待建设', cls: 'pending' },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 字段级摘要：按 endpoint 从已拉取值抽取人类可读摘要
export function configSummary(status, item, fetchedVal) {
  if (status !== 'readable' || !item?.endpoint || fetchedVal == null) return '';
  const v = fetchedVal;
  switch (item.endpoint) {
    case '/api/config/llm':
      return `provider=${esc(v.provider || '-')} / model=${esc(v.model || '-')}`;
    case '/api/config/seven-dim':
      return `维度数=${Array.isArray(v.dims) ? v.dims.length : (v.dimensions ? Object.keys(v.dimensions).length : '-')}`;
    case '/api/pool-config':
      return `pick=${esc(v.pickRule || v.pick || '-')} / recycle=${esc(v.recycleAfterDays != null ? v.recycleAfterDays + 'd' : '-')}`;
    case '/api/methodology/skew':
      return `skills=${Array.isArray(v.skills) ? v.skills.join(',') : (v.count != null ? v.count : '-')}`;
    default:
      return '';
  }
}

function cardHtml(item, fetched) {
  const badge = STATUS_BADGE[item.status] || STATUS_BADGE.pending;
  let summary = '';
  let action = '';
  if (item.status === 'ready') {
    summary = esc(item.note || '');
    action = `<a class="btn" href="${esc(item.page)}">打开</a>`;
  } else if (item.status === 'readable') {
    const fv = fetched?.[item.endpoint];
    summary = fv && !fv.error ? configSummary('readable', item, fv) || '已加载' : esc(item.note || '');
    action = `<button class="btn" data-endpoint="${esc(item.endpoint)}">查看</button>`;
  } else {
    summary = `待建设：${esc(item.note || '')}`;
    action = `<span class="muted">—</span>`;
  }
  return `<article class="cfg-card ${badge.cls}" data-id="${item.id}" data-level="${esc(item.level || '')}">
    <div class="cfg-head"><span class="badge ${badge.cls}">${badge.icon} ${badge.label}</span><h4>#${item.id}${item.sRef ? ' · ' + esc(item.sRef) : ''} ${esc(item.name)}</h4></div>
    <p class="cfg-sum">${summary}</p>
    <div class="cfg-act">${action}</div>
  </article>`;
}

export function renderConfigCenter(items, fetched = {}) {
  const list = items && items.length ? items : (items ? items : CONFIG_ITEMS);
  const counts = { ready: 0, readable: 0, pending: 0 };
  for (const it of list) counts[it.status] = (counts[it.status] || 0) + 1;
  // §15.2：先按系统级/租户级两个一级分组，组内再按既有 G1–G4 组渲染
  const sections = LEVEL_GROUPS.map((lg) => {
    const inLevel = list.filter((i) => (i.level || 'tenant') === lg.level);
    if (!inLevel.length) return '';
    const subGroups = GROUP_ORDER.map((g) => {
      const inGroup = inLevel.filter((i) => i.group === g);
      if (!inGroup.length) return '';
      return `<div class="cfg-sub" data-group="${esc(g)}"><h4>${esc(g)}</h4><div class="cfg-grid">${inGroup.map((i) => cardHtml(i, fetched)).join('')}</div></div>`;
    }).join('');
    return `<section class="cfg-group" data-level="${lg.level}">
      <h3>${esc(lg.name)} <span class="cnt">${inLevel.length}</span></h3>
      ${subGroups}
    </section>`;
  }).join('');
  return `<div class="config-center" id="configCenter">
    <div class="cfg-overview">
      已就绪 <b>${counts.ready}</b> · 可读取 <b>${counts.readable}</b> · 待建设 <b>${counts.pending}</b> · 共 <b>${list.length}</b> 项
    </div>
    ${sections}
  </div>`;
}
