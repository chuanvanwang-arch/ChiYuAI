# Lightfield 官方博客研读速览（14 篇）

> 整理：2026-09-03 ｜ 来源：https://lightfield.app/blog（截至 2026-09-03 全部正式文章，逐篇 WebFetch 一手研读）
> 用途：ATTIO/Lightfield 深度学习配套速览；与 `docs/2026-09-03-attio-lightfield-study.md` 互为索引。
> 定位：Lightfield =「AI 原生 CRM」标杆，核心是 **Save → Understand → Act**（原始痕迹→机构记忆→模式浮现）；ATTIO =「柔性数据底座」标杆，核心是 **粒子化 + Universal Context + 可编程 schema**。二者可互补参照。

---

## 速览表

| # | 文章 | 日期 | 一页结论 | 对 CRM-ai-native 的启示 |
|---|---|---|---|---|
| 1 | [Why we built Lightfield](https://lightfield.app/blog/why-we-built-lightfield) | 2025-11-13 | 不是数据库/看板/自动化层，而是理解系统：**Reality comes first, everything else is computed from it**；自动捕获完整数据而非让录入变简单；understanding compounds versus fragments | LIGHT 四维（Chronology/Attribution/Causality/State）与 account-insight L2C 时间线方向一致；本项目补齐「因果叙事线」即对齐 |
| 2 | [LLMs also prefer stories to graphs and databases](https://lightfield.app/blog/llms-also-prefer-stories-to-graphs-and-databases) | 2026-02-20 | 模型对刚性图"抓得太死"，缺为什么相连；应喂**实时更新的编年叙事**+结构化数据；人的关系是可塑的，图妨碍建模，叙事允许动态重赋权重 | 印证本项目 ai-memory-lifecycle 叙事化客户记忆；对 account-insight「动态权重叙事替代静态关系图」提供一手论据 |
| 3 | [Contact and account data model improvements](https://lightfield.app/blog/contact-and-account-data-model-improvements) | 2026-02-27 | 联系人支持**多邮箱 + 多账户关联**；账户支持**多域名**；更灵活地表达客户关系 | 本平台 particles 关联可多对多（edges），天然支持；多域名/多邮箱语义可加为 meta_attr 动态属性 |
| 4 | [Improved chat, data model flexibility](https://lightfield.app/blog/improved-chat-data-model-flexibility) | 2026-02-20 | agent 用**代码执行**回答复杂问题、生成 artifact；联系人可关联**多账户**；可删除 select/multiselect 选项 | 代码即工具：本平台决策引擎可叠加「沙盒代码执行」作复杂溯源/对比（对标杆 deal diagnosis） |
| 5 | [MCP connectors, member pages, and more](https://lightfield.app/blog/mcp-connectors-member-pages-and-more) | 2026-02-06 | **MCP 连接器**按用户配置，可在 chat 与 workflow 中使用；成员 profile 页聚合账户/商机/会议/任务/时间线；workflow 支持定时触发器 | 本平台 MCP 双传输 + 41 action 暴露已对齐；成员聚合页可借鉴 account-insight（成员维度） |
| 6 | [Introducing Skills / It's time to put your CRM to work for you](https://lightfield.app/blog/introducing-skills) | 2026-04-08 | **Skills = 可重复工作流**（描述任务/步骤/约束，Agent 稳定执行）；三作用域（Workspace/User/System）；Skills Bank 按 Build pipeline→Know deals→Win deal→Run GTM 分层；**The context graph gets better over time, the system compounds** | Skills 三作用域 ≈ 本平台 SKILL 分级；GTM 分层可直接借鉴为 SKILL 目录；预建 Skill 银行 = 本平台 skill_registry |
| 7 | [How to use Skills & Knowledge](https://lightfield.app/blog/how-to-skills-knowledge) | 2026-04-14 | **Knowledge = 结构化上下文层**（ICP/竞品定位/异议处理/买家语言/资格标准）；经验法则：同一指令给新员工 3 次 = Skill；反复解释同一背景 = Knowledge | 与本平台 config_store 租户画像同源；可把「行业 Know-How（ICP/异议/竞品）」显式沉淀为租户级 Knowledge 供 Agent 消费 |
| 8 | [Agentic data import in Lightfield](https://lightfield.app/blog/agentic-data-import-in-lightfield) | 2026-03-25 | **导入即 agent 任务**：传 CSV → agent 读结构、推断映射、建 schema/管道/记录、自动去重、关联关系；90,000 条/小时；支持多文件缝合 | 迁移成本趋零（呼应第 10 篇）；ATTIO 抽取管线可叠加 agent 推断；对"数据倒入"类需求提供范式（agent 确认你确认，再执行） |
| 9 | [The founder's guide to evaluating an AI CRM](https://lightfield.app/blog/the-founders-guide-to-evaluating-an-ai-crm) | 2026-01-23 | AI CRM 三分法（外挂 AI / 无世界模型自动补全 / 世界模型地基）；**五测试**：Capture / Synthesis / Why / Query / Action | 自评清单：本平台 Capture（事件捕获）✅ / Synthesis（跨商机模式）🟡 / Why（决策因果）✅ / Query（NL 查询）🟡 / Action（洞察到行动）🟡 |
| 10 | [The dissolution of integrations and data moats in SaaS](https://lightfield.app/blog/the-dissolution-of-integrations-and-data-moats-in-saas) | 2026-01-28 | **当迁移与集成的成本趋近于零，平庸产品无法再靠锁定客户续命**；agent 化数据迁移（代码执行替代手工）让迁移成本断崖 | 本平台零信任 + 决策问责 + 行业配置化是差异化护城河；迁移壁垒被 AI 消解后，能力本身成为竞争点 |
| 11 | [Designing for outbound that compounds on itself](https://lightfield.app/blog/designing-for-outbound-that-compounds-on-itself) | 2026-05-11 | **一手上下文 > 二手上下文**：外呼应基于你的赢单/买家语言/推进特征（而非第三方 enrichment）；每个循环把 funnel 数据写回知识库 → 复利 | 本平台 decision provenance + 复盘回路可补「赢单语言回写」闭环；用历史赢单作为外呼证据源 |
| 12 | [Building the CRM that works for you](https://lightfield.app/blog/building-the-crm-that-works-for-you) | 2026-05-07 | **CRM 应记录工作本身，而非工作的输出**（call 结束不是记 note，而是有上下文去干活）；Agentic Pipeline Generation：CRM 告诉你打谁/说什么/监控什么 | 本平台应从"记录工具"转向"有上下文干活的工具"：第 0 闸 + 决策引擎已是执行方向 |
| 13 | [Sequences, record merge and improvements to custom objects](https://lightfield.app/blog/sequences-record-merge-and-improvements-to-custom-objects) | 2026-06-19 | **Record merge**（合并重复记录，关系/字段/链接并至保留记录，弃记录内容保全在 activity log）；自定义对象支持关系过滤/汇总卡/成员列 | 与 ATTIO 软删除 + 本平台软合并（merged_into）同构；弃记录保全活动日志 = 本平台禁 DELETE 铁律 |
| 14 | [Field value history, improvements to sequences](https://lightfield.app/blog/field-value-history-improvements-to-sequences) | 2026-07-10 | **字段值历史视图**（活动日志可回溯字段变更）；序列回复情感分类（interested/not interested）；Slack 频道同步预览 | 对齐本平台 decision provenance + audit_event 前后值；「字段历史」可扩展为 account-insight 的字段级时间线 |

---

## 核心提炼（一句话×3）

1. **世界观**：`Save → Understand → Act`；原始交互痕迹是唯一真相源，字段/摘要/看板都是派生视图（Reality comes first）。
2. **数据哲学**：`Stories > Graphs`——对人际关系，实时更新的编年叙事强于刚性知识图；模型能动态重赋细节权重。
3. **工程哲学**：`Migration/integration costs → 0`——AI 消解迁移与集成壁垒后，**能力本身成为护城河**（与决策问责、零信任叠加即本平台的组合定位）。