"""RRF 混合召回：score = Σ_w 1/(rank_w + K)。K=60 对齐方案。"""


def rrf_fuse(rankings: dict[str, list[str]], k: int = 60) -> dict[str, float]:
    """rankings: {维度: [候选ID按该维排序]}。返回 {候选ID: RRF 分}。"""
    scores: dict[str, float] = {}
    for dim, ranked in rankings.items():
        for rank, cid in enumerate(ranked, start=1):
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (rank + k)
    return scores
