from chiyu_group.ingest.loader import load_sample
from chiyu_group.ingest.mapper import Ticket


def test_sample_loaded():
    ts = load_sample()
    assert len(ts) == 43  # 源 xlsx 实测有效数据 43 条（row 7-13 空行）
    assert all(isinstance(t, Ticket) for t in ts)
    assert all(t.order_id for t in ts)          # 编号非空
    assert all(t.push_time for t in ts)          # 时间可解析
