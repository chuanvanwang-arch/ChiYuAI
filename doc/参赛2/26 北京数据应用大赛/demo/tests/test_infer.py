import numpy as np
from chiyu_group.features.infer import hash_signature, InferBackend, cosine


def test_hash_signature_deterministic():
    v1 = hash_signature("电梯老是卡住", dim=384)
    v2 = hash_signature("电梯老是卡住", dim=384)
    v3 = hash_signature("上下楼不方便", dim=384)
    assert np.allclose(v1, v2)          # 确定性
    assert not np.allclose(v1, v3)      # 不同文本不同签名


def test_backend_without_model_falls_back_to_hash():
    backend = InferBackend(backend="none")   # 无权重
    vec = backend.encode("小区夜间施工")
    assert vec.shape == (384,)


def test_cosine_similarity():
    a = hash_signature("电梯卡住", 384)
    b = hash_signature("电梯卡住", 384)
    c = hash_signature("广场舞噪音", 384)
    assert cosine(a, b) > 0.99
    assert cosine(a, c) < cosine(a, b)
