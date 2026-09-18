from fastapi.testclient import TestClient
from chiyu_group.serving.api import app


def test_full_demo_flow():
    c = TestClient(app)
    assert c.post("/api/reset").json()["status"] == "reset"
    rep = c.post("/api/replay", json={"dataset": "sample"}).json()
    assert rep["status"] == "done" and rep["total"] == 43  # 实测样例 43 条
    st = c.get("/api/state").json()
    assert st["ingest_count"] == 43
    ev = c.post("/api/evaluate", json={"dataset": "sample"}).json()
    assert "macro_f1" in ev
    exp = c.get("/api/export")
    assert "order_id,gid" in exp.text
