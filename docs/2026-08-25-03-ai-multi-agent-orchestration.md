# AI 原生 CRM · 03 编排体系设计（ai-multi-agent-orchestration）

- 日期：2026-08-25
- 方法论依据：`ai-multi-agent-orchestration`（任务切分+状态机+环境隔离+结果回收四支柱；六轮对话式工作流）
- 业务基线：`docs/2026-08-24-ai-native-sales-crm-design.md` §5ter.11（审批待办四视角派发）+ §5ter-quater Q.20（能力×业务设计输入）
- 前置架构：`docs/2026-08-25-ai-native-crm-overall-design.md` §2（10 能力落位：编排=L3 智能体平面，阶段 1 启动）+ §5（阶段 1 底座验收锚点：kanban dispatch 派发真实任务）
- 前置粒子：`docs/2026-08-25-01-ai-particle-system-design.md` §7（从粒子模型推导垂直 Agent：状态机转换 ≠ Agent；信号=理解非结构化/多源融合/外部分析）

> ⚠️ 本文档按 SKILL 六轮对话式工作流逐轮确认后增量写入，**未获用户确认不得进入下一步骤**。每轮确认后追加该轮产出；六轮全部确认后汇总自查 → git 提交 → 请用户审查 → 批准后进入 writing-plans。

---

## 第 1 轮（已确认）· 编排四支柱（架构决策）

**用户确认的三个决策**（AskUserQuestion 逐题确认）：

| 决策项 | 选择 | 理由 |
|---|---|---|
| 编排拓扑 | **中心化看板**（非 swarm / 非嵌套） | 任务持久化 DB + 强状态观测 + 可重派发恢复；与 PDM/P2P 已验证底座同构（agentLoop+kanban dispatch+SSE 组件直接复用）；CRM 业务闭环（L2C 状态机流转）需有序可观测推进，不需要去中心化探索 |
| 任务切分 | **按阶段批次切分**（阶段1底座→阶段2认知→阶段3闭环，批次内再拆 Task） | 与三阶段执行路径对齐；批次内拆 Task 至「可独立派发、可独立验收」最小单元；依赖用 depends_on 串联，nextReadyTask 只放出「上游全部 done」的任务（依赖门控） |
| 结果回收 | **任务表 + 产物库双写** | `tasks.result` 列存摘要轨迹 + 产物实体表存结构化 payload（分析结果/预警单/审批快照）；跨重启可读、SQL 可查、进审计事件流；原则「回复会丢、文件不会」，绝不靠进程返回值回传 |

**架构决策固化**：
- **任务状态机**：最小完备集 `ready → running → done/failed → blocked`（zombie 识别 + reset 幂等），详见第 2 轮。
- **事件与任务分实体**：事件=信号可幂等消费；任务=有状态工作，**不用任务表存事件**；同一事件重复触发只建一个任务（事件 id 去重）；失败重试的是任务不是重新消费事件。
- **worker 环境隔离**：profile 注入为唯一通道（worker 读 profile 专属 config，改 root 对 worker 无效）；派发继承调度者 os.environ，解释器一致。
- **写操作审计**：每个状态转换留审计（谁/何时/为什么）；审批 Action 只守卫不翻转（L4 治理铁律）。
- **输入输出边界**：任务 payload 必须自包含（worker 不查事件源也能干活）；结果双写回传（tasks.result + 产物实体表）。

**与验证底座对齐清单**（复用 PDM/P2P 已跑通组件，不重新发明）：
- agentLoop 引擎（感知→决策→动作→质量闸门→升级，含 llmThink 插拔/context 注入/onDone memory 回写/evaluator/evaluator 触发）
- kanban dispatch（派发/超时/熔断/重试/重置）
- 5 事件域 SSE 总线（task/trace/approval/particle/payment）
- output guard（引用校验/置信度/脱敏）
- action-confirm（写操作确认）

---

## 第 2 轮（已确认）· 任务状态机

**用户确认的三个决策**（含一轮反模式修正）：

| 决策项 | 选择 | 理由 |
|---|---|---|
| 状态集 | **极简四态** `ready → running → done/failed` | 初始选「极简三态」，指出反模式硬伤（无 failed 无法表达重试/熔断；无 blocked 无法表达审批等待；无 zombie 无法回答「卡没卡」）后，折衷为**极简四态**：比三态只多 `failed` 显式状态，保住「失败可恢复」编排底线；不引入 blocked/reviewing/zombie 完整治理（阶段 2 引入审批流时再加 blocked(approval)） |
| 熔断阈值 | **failure_limit=3** | 连续失败 3 次即熔断（成功/显式 reset 才清零连续计数；重试保留计数）；解阻塞=人工 reset 后重派发；防无限重试风暴烧额度 |
| 质量闸门 | **阶段 1 不引入** | done=终点；评估驱动回滚（reviewing）推迟到阶段 2/3（ai-feedback-loop 落地时）；失败熔断已覆盖基本质量保障 |

**状态机设计固化**：
```
ready → running → done
          │   │
          │   └→ failed → (重试≤2) → ready
          │           └→ (连续失败≥3) → blocked ← 熔断（阶段1 blocked=仅标志位，无审批语义）
          └→ (进程死/超时) → failed → (重派发) → ready
```
- **每个状态转换留审计**（actor/timestamp/reason），否则不可排查。
- **连续失败计数语义**：只在成功（done）或显式 reset 时清零；重试（failed→running）保留计数，3 次即熔断。
- **解阻塞路径**：人工 `reset`（幂等：清失败计数/worker_pid/block，任何状态可重新派发）。
- **审批闸门 ≠ 故障（阶段 2 预留）**：worker 遇 needs_approval 应 `blocked(approval)` 等待 HITL，不归入 failed/circuit_break。
- **质量闸门（阶段 2/3 预留）**：`done →(evaluator reject)→ reviewing → ready(带反馈) → running(重跑)`；block_kind 分 circuit_break/approval/manual；失败驱动（熔断）vs 质量驱动（评估 reject）分开；评估者与被评估者隔离（不可自我评估）。

**与验证底座对齐**：kanban dispatch 现有失败处理（连续计数/熔断/重试/重置）直接复用；failed 显式状态与 PDM 已验证一致。

---

## 第 3 轮（已确认）· worker 派发机制 + 并发限流

**用户确认的三个决策**（含一轮方案对比）：派发模式先给三方案优缺点对比（调度器直调/CLI 子进程/事件轮询），用户查看对比后选推荐项。

| 决策项 | 选择 | 理由 |
|---|---|---|
| 派发模式 | **调度器直接调 agentLoop 引擎** | 单栈最简、最快接线、与阶段 1「agentLoop+kanban 接线」验收锚点贴合；阶段 1 接受单进程连坐（单机验证环境，重启即恢复）；阶段 2 并发多任务时再引入子进程隔离（CLI 派发 + pid/zombie 治理）；事件轮询排除（与「派发真实任务」锚点冲突） |
| 环境隔离 | **角色级 context 注入** | worker 执行按角色注入上下文（L4 治理决策层）——阶段 2 引入「五角色七要素」；**阶段 1 先按任务类型注入固定上下文**，角色化留到阶段 2 上下文分层落地；profile 专属配置阶段 1 价值有限（单一底座多 profile 共用），全局共享排除（改一个崩一片反模式） |
| 并发控制 | **max_inflight=3 + 批次派发 + 指数退避** | 并发上限=硬约束（下游 LLM 供应商额度）；治理=派发队列限流 + 每批 N 个 + 指数退避；判断限流 vs 真实故障看成功率分布（限流=部分成功+其余同类错误；真实故障=全部同类错误）；阶段 1 单机小批量验证 |

**派发机制设计固化**：
- **worker 执行单元必须走 Agent Loop**（四能力串联，六条不可省）：① worker ≠ 直跑 dispatch（须经 Agent Loop 保步骤编排/轨迹/HITL 检查点）；② llmThink 可插拔但调用签名预留入口；③ context 注入在 worker 内（assembler 每步前注入）；④ memory 回写在 onDone（否则 L2 无新案例冷启动无法自解）；⑤ evaluator 在 onDone 触发（阶段 2/3 启用）；⑥ 轨迹持久化 agent_loop_traces。
- **幂等契约**：同一任务重复派发不产生重复副作用，worker 侧用 task_id 做幂等键。
- **结果落盘不靠聊天回传**：tasks.result 列（摘要）+ 产物实体表（结构化 payload）双写；后端读库回传。
- **profile 注入 = 环境隔离唯一通道**（阶段 2 角色化后生效）：worker 读角色专属 config 非 root config——改 root 对 worker 无效。
- **双实例陷阱预防**：调度器无状态可重启（单例锁 + 存活探测，杜绝双实例并存）。
- **故障治理清单（阶段 1 覆盖）**：① 僵尸任务（进程死但 running → pid 探测后 reset）② 熔断误伤（限流致连续失败 → 先降并发再解阻塞，不一边解阻塞一边满并发重试）③ 结果丢失（依赖聊天回复 → 落盘+读文件）④ 环境漂移（root 与角色配置混改 → 角色全量声明，root 只放共享项）。

**事件触发任务（阶段 2/3 预留）**：事件与任务分实体（事件=信号可幂等消费；任务=工作有状态，不用任务表存事件）；任务 payload 自包含（worker 不查事件源也能干活）；同一事件重复触发只建一个任务（事件 id 去重）；失败重试的是任务不是重新消费事件。

**编排观测面**：观测面板与编排数据同源（直接读 tasks/agent_loop_traces，不另开表）；三态渲染（加载中/空数据/错误互不阻塞）；动作后联动刷新——呼应 5 事件域 SSE 总线（task 域阶段 1 先落地）。

---

## 第 4 轮（已确认）· 六维推导出 Agent 清单

**推理点识别**（对照 01 粒子文档 AI 属性能力轴，识别 8 推理点）：商机推进建议（多源融合）、客户健康度（360°评估）、标讯→线索筛选（非结构化理解）、跟进摘要（非结构化理解）、一句话写 CRM（NL→Action）、报价生成建议、合同条款风险、预警生成（A_Alert 规则）。

**聚类收敛过程**（含两轮用户裁决）：
1. 初案 4 Agent（deal-coach / account-insight / lead-miner / crm-copilot），用户质疑「报价、合同呢」→ 补充报价/合同推理点（quote-builder 报价生成 + contract-advisor 条款风险），用户选「立即加进清单」→ 6 Agent。
2. 用户质疑「SKILL 里面没有设置 AGENT 的原则和规范吗」→ 对照 SKILL 裁决策略 3 条逐 Agent 审查：
   - **原则 1** knowledge-searcher 不是 Agent → 未建检索 Agent ✅
   - **原则 2** 单步推理不走 Agent 容器（门槛 = 多步推理回路 ≥2+ 次 LLM 调用）→ quote-builder **推理成分弱**（官方 CordysCRM 报价金额=规则运算符计算），**降为规则引擎不建 Agent**；account-insight 可合入 deal-coach（客户健康度=商机健康度上游输入，同一推理回路）；contract-advisor 可合入 lead-miner（B_Brief 非结构化理解能力复用）
   - **原则 3** 冷启动降级 → 注册完整+运行自适应（见下）
   - 收敛规范「多 Agent 设计收敛到 2-3 个」
3. **用户裁决 3 Agent 规范收敛**：crm-copilot + deal-coach（含客户健康度）+ lead-miner（含合同条款解析）；报价金额=规则计算不建 Agent。

**3 Agent 清单（六维推导，逐 Agent 规范模板）**：

### Agent A1 · crm-copilot（NL 接诊 → Action）
| D1 能力轴 | D2 知识需求 | D3 数据源 | D4 注入深度 | D5 模型路由 | D6 SKILL 依赖 |
|---|---|---|---|---|---|
| C_Classify + J_Judge | L1（Action Registry）+ L3（HITL 检查点） | 对话输入 + Action Registry + 粒子 Schema | level=2 | full（写操作）+ HITL | #5 Action + #6 编排 + #8 NL |

- 推理回路：NL 意图→Action 映射 + 参数抽取 → 写通道三闸（confirm+HITL）
- 业务基线：§6.3ter 官方核心场景「一句话完成 CRM 写入」（录入 1-2 分钟/条 → 10 秒/条）

### Agent A2 · deal-coach（商机推进 + 客户健康度）
| D1 能力轴 | D2 知识需求 | D3 数据源 | D4 注入深度 | D5 模型路由 | D6 SKILL 依赖 |
|---|---|---|---|---|---|
| S_Sight + J_Judge | L1（DEAL/ACCOUNT 粒子）+ L2（历史案例 ≥10） | DEAL(stage_history/followup/probability) + ACCOUNT+CONTACT+ASSET(工商校验) | level=3 | full（跨模块判断） | #1 粒子 + #3 上下文 + #9 反馈 |

- 推理回路：阶段历史+跟进+赢率+金额 多源融合 → 下一阶段建议（商机）；交易+跟进+工商校验 360° → 健康度/流失风险评分（客户）
- 业务基线：§5ter.3 商机阶段-赢率-回退状态机 + §5ter.3 预计/实际结束时间对账；客户 360 聚合

### Agent A3 · lead-miner（标讯→线索 + 合同条款）
| D1 能力轴 | D2 知识需求 | D3 数据源 | D4 注入深度 | D5 模型路由 | D6 SKILL 依赖 |
|---|---|---|---|---|---|
| B_Brief + S_Sight + J_Judge | L1（KNOWLEDGE 行业/区域词表）+ L2（案例 ≥10） | ASSET(标讯/合同条款) + KNOWLEDGE 词表 + DEAL | level=2 | full（非结构化理解） | #1 粒子 + #2 本体 + #4 记忆 |

- 推理回路：理解非结构化招标文本 → 提炼结构化线索（标讯）；条款要素抽取 → 风险提示（合同）
- 业务基线：§5ter.12 标讯订阅 + 合同到期预警（A_Alert 规则闸）

**冷启动策略（用户裁决两全方案）**：
- **注册完整 + 运行自适应降级**：三个 Agent 注册时即完整能力（满足「直接完整能力」要求）；运行态按 L2 案例数自动降级——<3 → 纯规则执行（编排不走 Agent Loop）、3-10 → 受限（modelRoute 降一档 + 推理标注低置信）、≥10 → 完整能力。兼顾完整性声明与 SKILL 冷启动规范（不声称无案例完整能力）。
- **每 Agent ≥10 条种子**（用户选择高于默认 ≥5）：设计态人工注入每 Agent ≥10 条种子案例（source=seed 权重恒定、免运行态降级期）：deal-coach 商机推进案例、lead-miner 标讯提炼案例、crm-copilot 意图映射案例；运行态自动提取 result 为 production 案例（source=production 按新鲜度排序）。

---

## 第 5 轮（已确认）· Agent 定义卡

**每 Agent 六维值齐备**（第 4 轮六维推导表已交付）；本节固化数据就绪度评估 + 上下文支撑度校验 + SD 校验结论。

**数据就绪度评估**（对照 01 粒子清单）：

| Agent | 所需数据 | 01 粒子就绪 | 缺口分级 | 修复路径 |
|---|---|---|---|---|
| crm-copilot | Action Registry + 粒子 Schema | ✅ 支撑粒子 skill/action 已设计 | **无** | 阶段 2 落地 Action 时充实 |
| deal-coach | DEAL stage_history + followup + ACCOUNT | ✅ P1/P2 就绪 | **P1**（AI 属性 win_probability_adjusted/age_in_stage 阶段 2 才计算） | 阶段 2 上下层落地时补 |
| lead-miner | ASSET（标讯类型）+ KNOWLEDGE 词表 | ✅ P8/P9 就绪 | **P2**（合同条款类型阶段 3 才有业务数据） | 阶段 3 业务闭环引入 |
| 关联支撑 | memory（L2 案例）+ ontology 向量 | ✅ 支撑就绪 | **P1**（memory 阶段 2 落地） | 阶段 2 记忆三构件落地 |

**上下文支撑度校验**（L1-L4 逐层）：

| Agent | L1 图通道 | L2 向量+FTS | L3 蓝图协同 | L4 闸门实时 |
|---|---|---|---|---|
| crm-copilot | ✅（粒子 Schema→AGE 可达，阶段 1） | ✅（阶段 2） | ⚠️（HITL 闸阶段 2/3） | ⚠️（审批阶段 2/3） |
| deal-coach | ✅ | ⚠️（案例<10 冷启阶段） | ⚠️ | ⚠️ |
| lead-miner | ✅（KNOWLEDGE 词表） | ⚠️（标讯案例阶段 3 才有） | ⚠️ | ⚠️ |

**SD 校验结论**：
- 三个 Agent 的 L3/L4 支撑（审批闸/蓝图契约/闸门实时）均为阶段 2/3 落地 → **阶段 1 只注册不启用**（与第 4 轮「注册完整+运行自适应」一致）。
- 缺口分级明确：**P0 无**（粒子底座已就绪）；**P1** = AI 属性计算 + memory 落地（阶段 2）；**P2** = 标讯/合同业务数据（阶段 3）。
- 阶段 2 验收判据：deal-coach 依赖的 AI 属性（win_probability_adjusted 等）计算管线跑通 → 上下文注入可用；lead-miner 依赖的标讯 ASSET 写时校验（§5ter.12）→ 非结构化理解可用。

**Agent 定义卡落点（用户裁决）**：**写入设计文档 + 落库 spec**——六段式定义卡（identity/capabilities/context/memory/evaluation/governance）写入本文档固化（设计态），同时落库 agents 表作运行时契约；设计态卡片与运行时 spec 同源（阶段 2 实施 agents 表时按本文档卡片建表）。

---

## 第 6 轮（已确认）· Spec 契约 + 装配校验

**用户确认的三个决策**（含一轮安全默认值修正）：

| 决策项 | 选择 | 理由 |
|---|---|---|
| Spec 落库 | **agents 表 JSONB 全量六段** | agents 表建 identity/capabilities/context/memory/evaluation/governance 六字段（JSONB），与 PDM 已验证 agents 表同构；阶段 1 建表、阶段 2 填充；设计态卡片（本文档）与运行时 spec 同源 |
| 装配校验 | **六条全启用** | ① derivedFrom 存在 ② 依赖 SKILL validated ③ 权限闭包（⋃(SKILL.calls)⊆capabilities.actions）④ Action 在 Registry 存在 ⑤ KG 就绪度/冷启动达标 ⑥ metricTemplate+evaluator 可用——阶段 1 无 KG 无评估器，⑤⑥ 启动时**降级语义支持**（KG 未就绪=降级启动并标注，非拒绝）；裁决原则：能力缺失→拒绝，数据不足→降级 |
| 能力面裁剪 | **按 agentId 裁剪 + 知识分层公开** | agents.md/能力面按 agentId 裁剪（清单即权限边界，清单外执行层也拒绝）；初始选「默认公开」，指出 SKILL「知识范围默认全闭」硬规则后折衷为**分层公开**：L1 平台知识层（Schema/词表/方法论）默认公开 + **L2 实例数据 organization_id RBAC 过滤**（与 §4.4 RBAC 贯穿一致）；不违反安全默认值（敏感实例数据仍受控） |

**能力面裁剪固化**：
- `generateAgentsMd()` 必须接受 agentId 按 spec 裁剪（Action/SKILL/粒子/知识检索边界/记忆读写域/降级状态）；清单与执行层校验同源（清单外 Action 执行层也拒绝）。
- 知识检索入口按 agentId 范围过滤 + maxHops 有上限；L2 实例数据默认 organization_id 过滤。

**Spec 契约与定义卡关系（断层补上）**：定义卡（第 4/5 轮）回答「该不该建这个 Agent」；Spec 契约（本轮）回答运行时「允许调用哪些 Action（最小权限）/依赖 SKILL validated？/能检索哪部分知识/依赖不满足拒绝还是降级/产出用什么指标验收」——两者都保留，不可互相替代。

**六条装配校验断言表**：

| # | 断言 | 失败处理 |
|---|---|---|
| 1 | derivedFrom 指向的 taskFlow 存在 | 拒绝注册 |
| 2 | 依赖 SKILL 全部 validated | 拒绝启动 |
| 3 | 权限闭包：⋃(SKILL.calls) ⊆ capabilities.actions | 拒绝注册 |
| 4 | 所有 action 在 Registry 中存在 | 拒绝启动 |
| 5 | KG 就绪度（覆盖率/冷启动案例）达标 | 降级启动并标注（阶段 1 启用降级语义） |
| 6 | metricTemplate + evaluator 可用 | 阶段 2 启用（评估器那时落地） |

---

## 汇总自查（SELF-REVIEW，六轮全部确认后）

**1. 覆盖度检查**（对照 SKILL 六轮映射 + 对话记录）：
- 第 1 轮四支柱：拓扑（中心化看板）+ 切分（阶段批次）+ 回收（任务表+产物库双写）✅
- 第 2 轮状态机：极简四态 + failure_limit=3 + 阶段 1 不引入质量闸门 ✅
- 第 3 轮派发+限流：调度器直调 agentLoop + 角色级 context + max_inflight=3 ✅
- 第 4 轮 Agent 清单：3 Agent 规范收敛 + 注册完整运行自适应 + 种子 ≥10 ✅
- 第 5 轮定义卡：数据就绪度（P0 无/P1 阶段2/P2 阶段3）+ 写文档+落库 ✅
- 第 6 轮 Spec 契约：agents 表六段 + 六条断言全启用 + 能力面裁剪+分层公开 ✅

**2. 占位符扫描**：无 TODO/TBD/「相似于」占位，各轮决策有具体值（阈值/状态集/Agent 名）✅
**3. 类型一致性**：状态机命名（ready/running/done/failed/blocked）、Agent 名（crm-copilot/deal-coach/lead-miner）、表名（agents/tasks/agent_loop_traces）前后一致 ✅
**4. 与前置文档一致**：01 粒子（P1 DEAL 状态机/支撑粒子 skill-action）↔ 03 Agent 数据源✅；总体架构 §2（编排=L3 阶段1）↔ 03 阶段 1 接线✅；§5ter.11 审批（blocked(approval) 阶段 2 预留）✅
**5. 反模式自查**：无 knowledge-searcher Agent / 无单步推理 Agent / 报价=规则引擎非 Agent / 无限重试有熔断 / 结果落盘非聊天回传 / 知识范围分层公开非默认全闭✅
**6. 决策留痕**：每轮用户裁决（含 2 次反模式修正：状态机极简三态→极简四态、知识范围全公开→分层公开）已在第 2/6 轮记录 ✅

**审批流 → 编排衔接（阶段 2 验收锚点）**：§5ter.11 审批待办四视角（待我审批/我处理的/我发起的/抄送我的）→ kanban 派发任务来源之一；审批 Action 只守卫不翻转（L4 治理铁律）；blocked(approval) 等待 HITL 不归 failed。此衔接写入阶段 2 实施计划输入。

---

*（六轮全部确认完毕。本文档为阶段 1 编排接线（agentLoop+kanban+状态机+派发+装配校验）与阶段 2/3 编排扩展（审批闸/质量闸门/子进程隔离）的设计输入。待用户审查本设计文档后进入 writing-plans。）*

## 7. 实现状态（阶段 1，2026-08-25 补）

> 与总体架构设计 §8 互证。本文档六轮设计阶段 1 接线部分已全部落地（与 PDM 已验证底座同构）；审批闸/子进程隔离/质量闸门/五角色七要素属阶段 2/3（设计已分级，见汇总自查第 5 轮 P0/P1/P2）。

- [x] **极简四态状态机**：`src/kanban/kanban.js`（`ready→running→done/failed→blocked`），与第 2 轮一致。
- [x] **failure_limit=3 熔断**：`src/kanban/types.js:5`；`kanban.js:81` 连续失败≥3 → `blocked(circuit_break)`，与第 2 轮「反模式修正：三态→四态」一致。
- [x] **派发 + 并发限流**：`src/kanban/dispatch.js:6,11`（`maxInflight=3` + 指数退避）、`src/kanban/scheduler.js:8`（单例锁 `scheduler_lock` 派发），与第 3 轮一致。
- [x] **3 Agent 六段式 + 装配校验**：`src/agent/agentSpec.js`（crm-copilot/deal-coach/lead-miner）、`src/agent/agents.js`（`assertAgentAssembly` 六条断言全启用，KG/evaluator 降级语义），与第 4/6 轮一致。
- [x] **agentLoop SKILL 驱动**：`src/agent/agentLoop.js`（rule 步骤零 LLM + 降级 think）、`src/skills/seed.js`（crm-deal-analyze/crm-skill-fallback），与第 6 轮一致。
- [ ] **降级语义（设计已声明）**：KG 未就绪 / 无 evaluator → 降级启动并标注（非拒绝），第 6 轮裁决原则「能力缺失→拒绝，数据不足→降级」。
- [ ] **未落地（阶段 2/3）**：HITL 审批闸（第 4 轮 Agent L3/L4 支撑）、子进程隔离 CLI 派发（第 3 轮环境隔离）、质量闸门 reviewing（第 2 轮）、五角色七要素 context 注入（第 3 轮，阶段 2 context-layering 落地）。