"""8 项确定性评分（可复现）。"""


def eight_scores(ctx: dict) -> dict:
    """ctx 为单条工单 vs 候选簇的评定上下文。
    返回 8 项评分（0~1），全部确定性函数。"""
    text = ctx.get("text_sim", 0.0)
    space = ctx.get("space_sim", 0.0)
    ent = ctx.get("entity_sim", 0.0)
    t = ctx.get("time_sim", 0.0)
    size = ctx.get("cluster_size", 0)
    recent = ctx.get("cluster_recent", 0)
    evid = ctx.get("cluster_evidence", 0.0)
    conflict = ctx.get("conflict", False)

    size_score = min(1.0, size / 10.0)                 # 规模合理性（≥10 满分）
    recent_score = min(1.0, recent / 5.0)              # 活跃度（近 5 单内活跃满分）
    evid_score = max(0.0, 1.0 - evid)                  # 证据完备：未核实占比越低越好
    conflict_score = 0.0 if conflict else 1.0          # 冲突检测：有冲突=0

    return {
        "语义一致性": text,
        "空间一致性": space,
        "实体一致性": ent,
        "时间邻近性": t,
        "簇规模合理性": size_score,
        "簇活跃度": recent_score,
        "证据完备度": evid_score,
        "冲突检测": conflict_score,
    }
