from chiyu_group.memory.note_track import NoteTrack


def test_upsert_idempotent():
    nt = NoteTrack()
    nt.upsert("C1", {"size": 2})
    nt.upsert("C1", {"size": 3})
    assert nt.get("C1")["size"] == 3      # 幂等重写
    assert len(nt) == 1


def test_missing_returns_none():
    assert NoteTrack().get("C99") is None
