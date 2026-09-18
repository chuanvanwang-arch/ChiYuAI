import datetime as dt
from chiyu_group.decision.audit import AuditRecord, AuditStore


def test_audit_record_fields_and_store():
    store = AuditStore()
    rec = AuditRecord(
        order_id="T1", action="join", cluster_id="C1",
        scores={"语义一致性": 0.8}, fused=0.95, confidence=0.83,
        redline_hit=False, redline_reason="", strategy_version="v1",
        elapsed_ms=42.0, ts=dt.datetime(2026, 6, 7))
    store.add(rec)
    assert len(store) == 1
    got = store.get("T1")
    assert got["action"] == "join" and got["cluster_id"] == "C1"
    assert got["elapsed_ms"] == 42.0
