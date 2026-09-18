"""数据三通道统一加载入口（内置样例/上传/挂载真实）。"""
import csv
from pathlib import Path
from typing import List
from chiyu_group.ingest.mapper import Ticket, raw_to_ticket

SAMPLE_PATH = Path(__file__).resolve().parent.parent.parent.parent / "data" / "sample" / "sample.csv"


def read_csv_rows(path: Path) -> List[dict]:
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows.append({k.strip(): v for k, v in r.items()})
    return rows


def load_sample() -> List[Ticket]:
    rows = read_csv_rows(SAMPLE_PATH)
    return [raw_to_ticket(r) for r in rows]
