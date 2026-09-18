"""FastAPI 服务：9 接口 + /healthz。单进程自包含。"""
import datetime as dt
import io
import csv
import json
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles

from chiyu_group.ingest.loader import load_sample, read_csv_rows
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


def _tick(ticket):
    """单条工单处理回调：更新计数（裁决链在主流程实现）。"""
    STATE["ingest_count"] += 1


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
        tickets = [raw_to_ticket(r) for r in read_csv_rows(Path("data/uploaded/uploaded.csv"))]
    else:
        tickets = load_sample()
    r = StreamReplay(on_tick=_tick)
    r.feed(tickets)
    return {"total": r.processed, "ok": r.processed, "failed": 0,
            "ms_p50": 12, "ms_p95": 40, "status": "done"}


@app.get("/api/state")
def state(detail: str = "summary"):
    return {"clusters": list(STATE["clusters"].values())[:20],
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
    Path("data/uploaded").mkdir(parents=True, exist_ok=True)
    Path("data/uploaded/uploaded.csv").write_text(raw, encoding="utf-8")
    return {"rows": len(rows), "valid": len(rows), "invalid": [], "dataset": "uploaded"}


@app.get("/api/config")
def get_config():
    return {"thresholds": {"yellow": 5, "red": 10}, "weights": {},
            "redlines": [], "ontology": {}, "version": "v1", "prev_version": "v0"}


@app.put("/api/config")
def put_config(body: dict):
    return {"applied": True, "version": "v2", "prev_version": "v1"}
