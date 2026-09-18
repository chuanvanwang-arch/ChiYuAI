from chiyu_group.memory.fuse import rrf_fuse


def test_rrf_rank_based():
    r1 = ["C3", "C1", "C2", "C4"]
    r2 = ["C3", "C1", "C2"]          # C3 双榜第一，C1 双榜第二
    scores = rrf_fuse({"text": r1, "space": r2}, k=60)
    assert scores["C3"] > scores["C1"] > scores["C4"]
    assert scores["C4"] == 1 / (4 + 60)      # 仅 text 榜


def test_rrf_empty_input():
    assert rrf_fuse({}) == {}
