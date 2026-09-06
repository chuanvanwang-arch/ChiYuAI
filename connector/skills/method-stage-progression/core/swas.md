# method-stage-progression · SWAS 商机回顾（core/swas.md）

> 每个可推进商机必须能回答四要素，否则不视为\"可推进商机\"（to-b 场景六标准 14）。

## 四要素

| 要素 | 含义 | 判定口径 |
|---|---|---|
| S Status | 当前阶段 | 与 methodology.json stages[].stage_key 对齐（S1-S6） |
| W Win Strategy | 制胜策略 | 明确\"为什么我们会赢\"（非笼统\"关系好\"） |
| A Action | 下一步行动 | 具体到人/事/时限（对齐 BH-01-02 目的明确） |
| S Setback Schedule | 输单时间节点 | 明确\"到什么时间点没达成就止损\"（对接 method-stop-loss） |

## 回顾流程

1. 取商机 stage / 最近拜访记录 / 下一步（visit_notes[].t_next）。
2. 逐要素填写（空 = 缺口）：
   - Status：读 stage 字段，与客户行为对照（core/progression.md 步骤 2）。
   - Win Strategy：为什么我们会赢——产品匹配？关系深度？商务优势？必须可陈述。
   - Action：下一步谁做什么、截止什么时候（对齐 TAORAN 的 N 要素）。
   - Setback Schedule：什么时间点没达成就止损（对接 method-stop-loss 的输单条件）。
3. 四要素全有 → \"可推进商机\"；任一空 → 判定为推进卡点（经理周会标注）。

## 使用时机

- 商机进入 S2 之后（方案阶段）每周回顾一次
- 经理周会抽查：无法回答 SWAS 的商机 = 推进卡点（§12.3bis 推进卡点判定依据）