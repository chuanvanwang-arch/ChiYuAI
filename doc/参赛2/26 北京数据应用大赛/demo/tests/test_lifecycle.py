import datetime as dt
from chiyu_group.memory.lifecycle import ClusterLifecycle, ClusterState


def test_state_machine_full_cycle():
    lc = ClusterLifecycle(quiet_days=7, distill_days=14)
    cid = "C1"
    lc.touch(cid, dt.datetime(2026, 6, 1))          # active
    assert lc.state(cid) == ClusterState.ACTIVE
    lc.touch(cid, dt.datetime(2026, 6, 10))          # 距上次 9 天 > 7 → quiet
    assert lc.state(cid) == ClusterState.QUIET
    lc.touch(cid, dt.datetime(2026, 6, 30))          # 距上次 20 天 > distill → distilled
    assert lc.state(cid) == ClusterState.DISTILLED
    lc.mark_archived(cid, dt.datetime(2026, 6, 25))
    assert lc.state(cid) == ClusterState.ARCHIVED
    lc.revive(cid, dt.datetime(2026, 7, 1))          # 复活
    assert lc.state(cid) == ClusterState.ACTIVE


def test_archived_auto_revive_on_touch():
    """归档簇若再次命中工单，自动复活（扩展检索命中场景）。"""
    lc = ClusterLifecycle(quiet_days=7, distill_days=14)
    lc.mark_archived("C9", dt.datetime(2026, 6, 1))
    assert lc.state("C9") == ClusterState.ARCHIVED
    lc.touch("C9", dt.datetime(2026, 7, 10))
    assert lc.state("C9") == ClusterState.ACTIVE
