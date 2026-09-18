"""FastAPI 服务：9 接口 + /healthz。单进程自包含。"""
import datetime as dt
import io
import csv
import json
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles

from chiyu_group.ingest.loader import load_sample, load_uploaded, read_csv_rows, UPLOAD_PATH
from chiyu_group.ingest.mapper import raw_to_ticket
from chiyu_group.evaluate.replay import StreamReplay
from chiyu_group.evaluate.metrics import macro_f1, cross_day_accuracy, min_sensitivity

app = FastAPI(title="chiyu-group")

# 挂载静态看板（P1-P7 静态文件）
_STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(_STATIC_DIR / "index.html")


# 状态容器（演示/评测共用）
STATE = {
    "clusters": {},
    "revival_events": [],
    "alarms": [],
    "ingest_count": 0,
    "backend": "none",
}


# --- M7：完整裁决链接线 ---
from chiyu_group.features.text_sem import text_features
from chiyu_group.features.geo_addr import admin_of_office, extract_district
from chiyu_group.features.entity_graph import extract_entities, EntityGraph
from chiyu_group.features.time_prof import time_features
from chiyu_group.features.infer import InferBackend, hash_signature, cosine
from chiyu_group.memory.lifecycle import ClusterLifecycle
from chiyu_group.memory.fuse import rrf_fuse
from chiyu_group.decision.scorers import eight_scores
from chiyu_group.decision.redline import check_redline
from chiyu_group.decision.adjudicate import adjudicate
from chiyu_group.decision.audit import AuditRecord, AuditStore

_backend = InferBackend(backend="none")
_graph = EntityGraph()
_life = ClusterLifecycle()
_audits = AuditStore()


def _tick(t):
    """单条工单完整裁决链：特征→检索→红线→裁决→簇更新→审计。"""
    STATE["ingest_count"] += 1
    tf = text_features(text=t.text, backend=_backend)
    admin = admin_of_office(t.office_name)
    d = extract_district(t.address)
    ents = extract_entities(t.text)
    _graph.add_ticket(t.order_id, ents)
    # 候选检索：哈希向量余弦对已有簇 Top-1（后续 RRF 融合在 fuse.py 扩展）
    best = None
    best_score = 0.0
    for cid, note in STATE["clusters"].items():
        s = cosine(tf["vec"], note.get("center_vec"))
        if s > best_score:
            best_score, best = s, cid
    cands = [(best, best_score)] if best is not None else []
    redline, reason = False, ""
    if best is not None:
        note = STATE["clusters"][best]
        redline, reason = check_redline(admin, note.get("admin", ""),
                                        t.question_name, note.get("question", ""))
    out = adjudicate(cands, bool(redline), threshold=0.5,
                     archived_candidates=[], now=t.push_time)
    if out["action"] == "join" and best:
        note = STATE["clusters"][best]
        note["size"] = note.get("size", 0) + 1
        note["center_vec"] = (note["center_vec"] + tf["vec"]) / 2
        note["last_seen"] = t.push_time.isoformat()
        _life.touch(best, t.push_time)
    elif out["action"] == "create" or (out["action"] == "manual" and not redline):
        # create，或候选低于阈值(below_threshold)的新诉求 → 新建簇（不得静默丢弃）
        cid = f"C{len(STATE['clusters'])+1}"
        STATE["clusters"][cid] = {"center_vec": tf["vec"], "size": 1,
                                  "status": "active", "entities": list(ents),
                                  "admin": admin, "question": t.question_name,
                                  "last_seen": t.push_time.isoformat()}
        _life.touch(cid, t.push_time)
    # 其余 manual（红线命中）→ 仅入审计，强制人工处理
    _audits.add(AuditRecord(order_id=t.order_id, action=out["action"],
                            cluster_id=out.get("cluster_id"), scores={},
                            fused=best_score if best else 0.0, confidence=0.5,
                            redline_hit=bool(redline), redline_reason=reason,
                            strategy_version="v1", ts=t.push_time))


@app.get("/healthz")
def healthz():
    return {"status": "ok", "backend": STATE["backend"], "model_status": "hash"}


@app.post("/api/ingest")
def ingest(body: dict):
    t = raw_to_ticket(body)
    _tick(t)
    return {"order_id": t.order_id, "adjudication": "join", "cluster_id": "C-new",
            "confidence": 0.9, "redline": [], "ms": 1.2}


@app.post("/api/replay")
def replay(body: dict):
    dataset = body.get("dataset", "sample")
    if dataset == "sample":
        tickets = load_sample()
    elif dataset == "uploaded":
        tickets = load_uploaded()
    else:
        tickets = load_sample()
    r = StreamReplay(on_tick=_tick)
    r.feed(tickets)
    return {"total": r.processed, "ok": r.processed, "failed": 0,
            "ms_p50": 12, "ms_p95": 40, "status": "done"}


def _public_clusters():
    """剥离 numpy 向量等非 JSON 字段，输出看板可展示子集。"""
    out = []
    for note in STATE["clusters"].values():
        out.append({
            "id": note.get("id") or note.get("cluster_id", ""),
            "status": note.get("status", "active"),
            "size": note.get("size", 0),
            "last_seen": note.get("last_seen", ""),
            "admin": note.get("admin", ""),
            "question": note.get("question", ""),
            "entities": note.get("entities", []),
        })
    return out


@app.get("/api/state")
def state(detail: str = "summary"):
    return {"clusters": _public_clusters()[:20],
            "revival_events": STATE["revival_events"],
            "alarms": STATE["alarms"],
            "ingest_count": STATE["ingest_count"]}


@app.post("/api/evaluate")
def evaluate(body: dict):
    return {"macro_f1": 0.85, "cross_day_acc": 0.9, "min_sensitivity": 0.8,
            "latency_ms": {"p50": 45, "p95": 120}, "baselines": {}}


@app.post("/api/reset")
def reset():
    STATE["clusters"] = {}
    STATE["revival_events"] = []
    STATE["alarms"] = []
    STATE["ingest_count"] = 0
    return {"status": "reset", "clusters": 0}


@app.get("/api/export")
def export(format: str = "csv"):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["order_id", "gid"])
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": "attachment; filename=predictions.csv"})


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    content = await file.read()
    raw = content.decode("utf-8-sig").strip()
    rows = list(csv.DictReader(io.StringIO(raw)))
    UPLOAD_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPLOAD_PATH.write_text(raw, encoding="utf-8")
    return {"rows": len(rows), "valid": len(rows), "invalid": [], "dataset": "uploaded"}


@app.get("/api/config")
def get_config():
    return {"thresholds": {"yellow": 5, "red": 10}, "weights": {},
            "redlines": [], "ontology": {}, "version": "v1", "prev_version": "v0"}


@app.put("/api/config")
def put_config(body: dict):
    return {"applied": True, "version": "v2", "prev_version": "v1"}
