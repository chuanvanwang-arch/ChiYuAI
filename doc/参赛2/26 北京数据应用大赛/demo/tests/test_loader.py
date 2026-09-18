from pathlib import Path

from chiyu_group.ingest.loader import load_sample, load_real, load_uploaded, read_csv_rows
from chiyu_group.ingest.mapper import Ticket


def test_sample_loaded():
    ts = load_sample()
    assert len(ts) == 43  # 源 xlsx 实测有效数据 43 条（row 7-13 空行）
    assert all(isinstance(t, Ticket) for t in ts)
    assert all(t.order_id for t in ts)          # 编号非空
    assert all(t.push_time for t in ts)          # 时间可解析


def test_load_real_missing_is_empty(tmp_path: Path):
    """无真实挂载数据时不报错，返回空列表（评测现场由主办方挂载覆盖）。"""
    ts = load_real()
    assert isinstance(ts, list)
    # 若存在 real/real.csv 则读之；不存在返回 []
    if (Path(__file__).resolve().parent.parent / "data" / "real" / "real.csv").exists():
        assert len(ts) > 0
    else:
        assert len(ts) == 0


def test_load_uploaded_missing_is_empty(tmp_path: Path):
    """无上传数据时返回空列表。"""
    ts = load_uploaded()
    assert isinstance(ts, list)
    assert len(ts) == 0


def test_read_csv_rows_strips_columns(tmp_path: Path):
    p = tmp_path / "t.csv"
    p.write_text("工单编号,工单标题,问题点位\nA1,标题一,朝阳区××\n", encoding="utf-8")
    rows = read_csv_rows(p)
    assert rows == [{"工单编号": "A1", "工单标题": "标题一", "问题点位": "朝阳区××"}]
