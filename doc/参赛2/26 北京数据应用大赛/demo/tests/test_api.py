from fastapi.testclient import TestClient
from chiyu_group.serving.api import app


def test_healthz():
    c = TestClient(app)
    r = c.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_reset_and_state():
    c = TestClient(app)
    c.post("/api/reset")
    r = c.get("/api/state")
    assert r.status_code == 200
    assert "clusters" in r.json()


def test_export_csv():
    c = TestClient(app)
    c.post("/api/replay", json={"dataset": "sample"})
    r = c.get("/api/export")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "order_id,gid" in r.text


def test_upload_csv():
    c = TestClient(app)
    csv_content = "工单编号,工单标题,工单内容,推送时间,承办单位,问题分类,问题点位\nT1,测试,内容,2026-06-01 08:00:00,朝阳区分中心,城乡建设>施工管理>施工扰民,北京市朝阳区某地\n"
    r = c.post("/api/upload", files={"file": ("uploaded.csv", csv_content.encode("utf-8-sig"), "text/csv")})
    assert r.status_code == 200
    assert r.json()["rows"] == 1
