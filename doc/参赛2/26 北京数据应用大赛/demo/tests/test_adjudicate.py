import datetime as dt
from chiyu_group.decision.adjudicate import adjudicate


def test_hit_active_cluster():
    out = adjudicate(
        candidates=[("C1", 0.95)], redline_hit=False, threshold=0.5,
        archived_candidates=[], now=dt.datetime(2026, 6, 7))
    assert out["action"] == "join" and out["cluster_id"] == "C1"


def test_redline_forces_manual():
    out = adjudicate(
        candidates=[("C1", 0.99)], redline_hit=True, threshold=0.5,
        archived_candidates=[], now=dt.datetime(2026, 6, 7))
    assert out["action"] == "manual"


def test_no_candidate_create_or_revive():
    out = adjudicate(candidates=[], redline_hit=False, threshold=0.5,
                     archived_candidates=[("A1", 0.88)], now=dt.datetime(2026, 6, 7))
    assert out["action"] == "revive" and out["cluster_id"] == "A1"
    out2 = adjudicate(candidates=[], redline_hit=False, threshold=0.5,
                      archived_candidates=[], now=dt.datetime(2026, 6, 7))
    assert out2["action"] == "create"


def test_below_threshold_manual():
    out = adjudicate(
        candidates=[("C1", 0.4)], redline_hit=False, threshold=0.5,
        archived_candidates=[], now=dt.datetime(2026, 6, 7))
    assert out["action"] == "manual" and out["reason"] == "below_threshold"
