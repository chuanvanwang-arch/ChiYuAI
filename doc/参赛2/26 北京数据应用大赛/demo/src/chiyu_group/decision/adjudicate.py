"""归属裁决：命中(join)/扩展检索复活(revive)/新建(create)/人工(manual)。"""
import datetime as dt
from chiyu_group.decision.redline import check_redline


def adjudicate(candidates: list[tuple[str, float]], redline_hit: bool,
               threshold: float, archived_candidates: list[tuple[str, float]],
               now: dt.datetime) -> dict:
    """candidates: 活跃簇 Top-K [(cluster_id, rrf_score)] 降序。"""
    # 红线优先：命中红线 → 强制人工（无论置信度）
    if redline_hit:
        return {"action": "manual", "cluster_id": None, "reason": "redline"}
    if candidates:
        cid, score = candidates[0]
        if score >= threshold:
            return {"action": "join", "cluster_id": cid, "score": score}
        return {"action": "manual", "cluster_id": None, "reason": "below_threshold"}
    # 无活跃候选 → 扩展检索（含归档簇）
    if archived_candidates:
        cid, score = max(archived_candidates, key=lambda x: x[1])
        if score >= threshold:
            return {"action": "revive", "cluster_id": cid, "score": score}
    return {"action": "create", "cluster_id": None}
