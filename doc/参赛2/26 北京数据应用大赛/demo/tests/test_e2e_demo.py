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


def test_manual_branch_creates_new_cluster_when_below_threshold():
    """低于阈值/无候选时，工单应新建簇而非静默丢弃（M9 修复的 manual 漏分支）。"""
    c = TestClient(app)
    c.post("/api/reset")
    # 第一条：电梯诉求 → create 簇 C1
    r1 = c.post("/api/ingest", json={
        "order_id": "T-TH-001", "title": "电梯故障停运", "content": "电梯故障停运 困人",
        "push_time": "2026-09-01 08:00:00", "office_name": "朝阳区分中心",
        "question_name": "城乡建设>物业管理>电梯",
        "address": "北京市朝阳区某小区"})
    assert r1.status_code == 200
    st = c.get("/api/state").json()
    assert st["ingest_count"] == 1
    assert len(st["clusters"]) == 1  # 第一条 create 出 1 簇
    # 第二条：完全不同诉求（余弦 0.0 < 0.5）→ 候选低于阈值 → 应 create 新簇 C2
    r2 = c.post("/api/ingest", json={
        "order_id": "T-TH-002", "title": "公园座椅损坏", "content": "公园座椅损坏 无人维修",
        "push_time": "2026-09-01 09:00:00", "office_name": "朝阳区分中心",
        "question_name": "园林绿化>公园管理>设施维护",
        "address": "北京市朝阳区某公园"})
    assert r2.status_code == 200
    st = c.get("/api/state").json()
    assert st["ingest_count"] == 2
    assert len(st["clusters"]) == 2  # 第二簇被 create，未被静默丢弃
    # 第三条：半相似诉求（候选余弦 0.2097，0 < 0.2097 < 0.5 阈值）
    # → adjudicate 应返回 manual(below_threshold) → 若 _tick 漏 manual 则被静默丢弃
    r3 = c.post("/api/ingest", json={
        "order_id": "T-TH-003", "title": "电梯维修不及时", "content": "电梯维修不及时 居民投诉",
        "push_time": "2026-09-01 10:00:00", "office_name": "朝阳区分中心",
        "question_name": "城乡建设>物业管理>电梯",
        "address": "北京市朝阳区某小区"})
    assert r3.status_code == 200
    st = c.get("/api/state").json()
    assert st["ingest_count"] == 3
    # 期望：候选存在但低于阈值 → 不应静默丢弃；应 create 新簇 C3
    assert len(st["clusters"]) == 3, (
        f"manual 漏分支：第 3 条应 create 新簇（候选 0.2097 < 0.5），当前 clusters={len(st['clusters'])}")
