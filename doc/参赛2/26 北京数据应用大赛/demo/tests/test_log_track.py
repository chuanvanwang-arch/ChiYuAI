from chiyu_group.memory.log_track import LogTrack


def test_append_only_and_no_update():
    lt = LogTrack()
    lt.append("T1", {"title": "a"})
    lt.append("T2", {"title": "b"})
    assert len(lt) == 2
    # 不允许修改已有条目
    try:
        lt.update("T1", {"x": 1})
        assert False, "update should raise"
    except AttributeError:
        pass
    assert lt.get("T1") == {"title": "a"}


def test_duplicate_append_raises():
    lt = LogTrack()
    lt.append("T1", {"title": "a"})
    try:
        lt.append("T1", {"title": "b"})
        assert False, "duplicate should raise"
    except ValueError:
        pass
