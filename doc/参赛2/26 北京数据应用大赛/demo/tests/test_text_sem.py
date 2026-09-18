import pytest
from chiyu_group.features.text_sem import text_features, keyword_jaccard
from chiyu_group.features.infer import InferBackend


def test_keyword_jaccard():
    a = {"电梯", "卡住"}
    b = {"电梯", "卡住", "不动"}
    c = {"广场舞", "噪音"}
    assert keyword_jaccard(a, b) == pytest.approx(2 / 3)
    assert keyword_jaccard(a, c) == 0.0


def test_text_features_with_hash_backend():
    f = text_features(InferBackend(backend="none"), "电梯卡住，需要维修")
    assert "vec" in f and "kws" in f
    assert len(f["vec"]) == 384
    assert "电梯" in f["kws"]
