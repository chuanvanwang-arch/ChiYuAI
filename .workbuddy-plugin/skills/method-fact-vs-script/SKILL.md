---
name: method-fact-vs-script
description: 事实vs话术方法论——区分销售沟通中的事实（可验证证据）与话术（口头承诺/宣传表述），以事实为决策依据，话术仅作跟进线索，异议处理用事实+证据而非空泛承诺。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-fact-vs-script · 事实 vs 话术方法论

> 定位：销售（sales）/售前（presales）在**把客户沟通内容沉淀为商机判断依据**时，需要区分\"哪些是事实、哪些是话术\"参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；评估流程见 `core/evaluate.md`；评分门控见 `rules/scoring.md`；维度释义见 `references/dimensions.md`；角色视角见 `profiles/sales.md`、`profiles/presales.md`。

## 适用场景（调用即自然语言）

- \"客户说'预算没问题'，这是事实还是话术？\"
- \"这个商机的判断依据里，哪些是客户实锤、哪些只是口头说说？\"
- 把客户沟通内容分类为 事实（有证据可验证）/ 话术（口头表述需验证）并落入商机 payload

## 评估流程（四步）

1. 逐条分类：F（事实）→ S（话术）→ E（证据等级）
2. 判定事实：可验证（书面/第三方/实测）且无歧义 → 事实
3. 判定话术：口头表述/宣传性用语/无佐证 → 话术（标记为待验证线索）
4. 产出结论：`{ verdict, facts[], scripts[], evidence_map, gate }`，gate ∈ `FACT_CONFIRMED | NEEDS_VERIFICATION | SCRIPT_ONLY`

## 维度快查

| 维 | 含义 | 关键问题 |
|---|---|---|
| F | 事实 Fact | 有书面/实测/第三方证据且无歧义吗？ |
| S | 话术 Script | 口头表述/宣传用语/无佐证吗？是待验证线索还是空话？ |
| E | 证据等级 Evidence | 证据来源/等级（书面/实测/第三方/POC）决定可信度？ |

## 角色视角

- sales：把客户沟通沉淀为商机判断依据，话术不撑推进（`profiles/sales.md`）
- presales：技术方案/演示中的事实与宣传表述的边界（`profiles/presales.md`）

## 与既有机制衔接

- 输出与 BANT/MEDDICC 的证据优先级一致——事实优先于话术，口头意向不得单独支撑推进
- 事实/话术分类可作 `decision_scenario` 的 `eval_dimensions` 输入（商机判断的可靠性闸门）

## Action 读清单（评估数据源）

| Action | 用途 |
|---|---|
| `data-particle-read` | 读取商机/客户粒子（评估输入） |
| `data-particle-attr-read` | 属性元模型（方法论维度字段映射） |
| `crm-field-permission` | 字段级权限校验（评估范围过滤） |
| `crm-account-360` | 客户全景（背景/决策链佐证） |
| `crm-customer-360` | 敏感读：客户全维度（需角色确认） |

## Action 写清单（联动结果写回，经 crm-write 两阶段）

| Action | 用途 |
|---|---|
| `data-particle-update` | 事实证据/话术标记写回商机（来源可验证） |

> 写清单一侧为「方法论结果 → 业务写」联动面：本 method SKILL 不直接 dispatch 写 Action，一律经 crm-write 两阶段（第0闸 + action-confirm）执行。事实优先：不可验证话术不写入商机结论。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。