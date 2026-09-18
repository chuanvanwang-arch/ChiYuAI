"""评测四指标：宏平均F1 / 跨日合并准确率 / 最小成诉敏感度 / 耗时。"""


def macro_f1(pred: dict[str, set], truth: dict[str, set]) -> tuple[float, dict]:
    """pred/truth: {群诉ID: 工单ID集合}。返回 (宏平均F1, 每事件F1)。"""
    per = {}
    for g in truth:
        t, p = truth[g], pred.get(g, set())
        if not t:
            continue
        inter = len(p & t)
        precision = inter / len(p) if p else 0.0
        recall = inter / len(t) if t else 0.0
        per[g] = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    avg = sum(per.values()) / len(per) if per else 0.0
    return avg, per


def cross_day_accuracy(multi_window_groups: dict[str, bool],
                       merged: dict[str, bool]) -> float:
    """跨日群诉中被正确合并的比例。"""
    if not multi_window_groups:
        return 0.0
    ok = sum(1 for g in multi_window_groups if merged.get(g, False))
    return ok / len(multi_window_groups)


def min_sensitivity(small_groups: dict[str, set], found: set) -> float:
    """3~5 件小群诉召回。"""
    if not small_groups:
        return 0.0
    return sum(1 for g in small_groups if g in found) / len(small_groups)
