# method-role-map · 评分与门控（rules/scoring.md）

## 评分标尺

| 分档 | 含义 | 证据要求 |
|---|---|---|
| 0.0–0.5 | 无证据/反证 | 未识别角色、无法命名决策者、无接触记录 |
| 0.6–0.79 | 口头确认 | 客户口头提到角色存在，无书面/会议纪要佐证 |
| 0.8–0.94 | 书面/实测 | 组织架构图、会议纪要、已与该角色直接沟通 |
| ≥0.95 | 多方验证 | 该角色亲述立场 + 书面记录 + 内部线人交叉证实 |

## 门控（gate）

- `D/I` 任一维度 <0.6 → **BLOCKED_DECISION**（决策链未打通，禁止推进）。
- 存在已识别的**反对者且未转化**（反对立场、score<0.6）→ **BLOCKED_OBJECTOR**（先转化或绕行，禁止乐观推进）。
- D/I/U/S 四角色全部命名且立场可判 → **PATH_CLEAR**。
- 关键路径上存在角色未知（有决策者但决策流程不明）→ **UNKNOWN_TOPOLOGY**（先补拓扑再推进）。

## 与平台机制衔接

- `BLOCKED_DECISION / BLOCKED_OBJECTOR` 禁止 `crm-deal-advance` 阶段推进（第 0 闸联动）。
- 立场标注写入 `decision` 表（scenario_id=`ROLE_MAP_ASSESS`，disposition=对应 gate），供决策网络先例检索。
- 角色地图可作为 `crm-tech-proposal-create` 的前置评估（售前方案覆盖哪些角色关切）。