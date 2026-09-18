from chiyu_group.decision.scorers import eight_scores


def test_eight_scores_deterministic():
    ctx = {
        "text_sim": 0.8, "space_sim": 0.9, "entity_sim": 0.6, "time_sim": 0.7,
        "cluster_size": 6, "cluster_recent": 3, "cluster_evidence": 0.9,
        "conflict": False,
    }
    s1 = eight_scores(ctx)
    s2 = eight_scores(ctx)
    assert s1 == s2              # 确定性：同输入同输出
    assert len(s1) == 8
    assert 0 <= s1["语义一致性"] <= 1


def test_eight_scores_conflict_zero():
    ctx = {"conflict": True, "cluster_size": 20, "cluster_recent": 6}
    s = eight_scores(ctx)
    assert s["冲突检测"] == 0.0
    assert s["簇规模合理性"] == 1.0
    assert s["簇活跃度"] == 1.0
