from chiyu_group.decision.soft_score import soft_score


def test_disabled_by_default():
    assert soft_score("a", "b", enabled=False) is None   # 关闭=不叠加


def test_enabled_returns_bounded():
    s = soft_score("电梯卡住", "电梯不动", enabled=True, default=0.7)
    assert 0 <= s <= 1
