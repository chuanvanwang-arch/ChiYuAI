import datetime as dt
from types import SimpleNamespace
from chiyu_group.evaluate.replay import StreamReplay


def _t(push_time):
    return SimpleNamespace(push_time=push_time)


def test_replay_time_ordered():
    r = StreamReplay(on_tick=lambda t: None)
    events = [
        _t(dt.datetime(2026, 6, 1, 8, 0)),
        _t(dt.datetime(2026, 6, 3, 9, 0)),
        _t(dt.datetime(2026, 6, 2, 10, 0)),   # 乱序
    ]
    r.feed(events)
    assert r.processed == 3
    assert r.ticks == 3


def test_replay_preserves_order():
    seen = []
    r = StreamReplay(on_tick=lambda t: seen.append(t.push_time))
    events = [
        _t(dt.datetime(2026, 6, 3, 9, 0)),
        _t(dt.datetime(2026, 6, 1, 8, 0)),
    ]
    r.feed(events)
    assert seen == [dt.datetime(2026, 6, 1, 8, 0), dt.datetime(2026, 6, 3, 9, 0)]
