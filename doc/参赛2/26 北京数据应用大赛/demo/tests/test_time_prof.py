import datetime as dt
from chiyu_group.features.time_prof import time_features, TimeProfile, temporal_similarity


def test_time_features():
    t = dt.datetime(2026, 6, 7, 23, 30)
    f = time_features(t)
    assert f["hour"] == 23 and f["weekday"] == 6 and f["month"] == 6


def test_temporal_recency_decay():
    a = dt.datetime(2026, 6, 7, 23, 0)
    b = dt.datetime(2026, 6, 7, 23, 30)
    c = dt.datetime(2026, 6, 20, 23, 0)
    assert temporal_similarity(a, b, mu=0.5) > temporal_similarity(a, c, mu=0.5)


def test_periodic_profile_match():
    prof = TimeProfile.from_times([
        dt.datetime(2026, 6, 1, 23, 0), dt.datetime(2026, 6, 2, 23, 30)])
    t = dt.datetime(2026, 6, 9, 23, 15)
    assert prof.match(t) > prof.match(dt.datetime(2026, 6, 9, 8, 0))
