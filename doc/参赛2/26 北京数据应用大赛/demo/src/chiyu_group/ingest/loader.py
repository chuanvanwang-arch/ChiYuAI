"""数据三通道统一加载入口（内置样例/上传/挂载真实）。"""
import csv
from pathlib import Path
from typing import List
from chiyu_group.ingest.mapper import Ticket, raw_to_ticket

_SAMPLE_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data" / "sample"
_REAL_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data" / "real"
_UPLOAD_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data" / "uploaded"

SAMPLE_PATH = _SAMPLE_DIR / "sample.csv"
REAL_PATH = _REAL_DIR / "real.csv"
UPLOAD_PATH = _UPLOAD_DIR / "uploaded.csv"


def read_csv_rows(path: Path) -> List[dict]:
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows.append({k.strip(): v for k, v in r.items()})
    return rows


def load_sample() -> List[Ticket]:
    rows = read_csv_rows(SAMPLE_PATH)
    return [raw_to_ticket(r) for r in rows]


def load_real() -> List[Ticket]:
    """真实挂载数据（评测现场由主办方提供，含事件ID/是否群诉标注）。"""
    if not REAL_PATH.exists():
        return []
    rows = read_csv_rows(REAL_PATH)
    return [raw_to_ticket(r) for r in rows]


def load_uploaded() -> List[Ticket]:
    """上传通道数据（经由 /api/upload 写入）。"""
    if not UPLOAD_PATH.exists():
        return []
    rows = read_csv_rows(UPLOAD_PATH)
    return [raw_to_ticket(r) for r in rows]
