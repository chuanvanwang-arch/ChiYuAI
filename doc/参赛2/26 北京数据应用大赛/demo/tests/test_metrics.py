import pytest
from chiyu_group.evaluate.metrics import macro_f1, cross_day_accuracy, min_sensitivity


def test_macro_f1_average_over_events():
    # 事件G1: 真值{T1,T2,T3}，预测{T1,T2,T3,T4}；事件G2: 真值{T5,T6}，预测{T5,T6}
    pred = {"G1": {"T1", "T2", "T3", "T4"}, "G2": {"T5", "T6"}}
    truth = {"G1": {"T1", "T2", "T3"}, "G2": {"T5", "T6"}}
    f1, per = macro_f1(pred, truth)
    # G1: P=3/4 R=3/3 F1=2*0.75*1/(1.75)=0.8571; G2: P=1 R=1 F1=1
    assert per["G1"] == pytest.approx(6 / 7)
    assert per["G2"] == pytest.approx(1.0)
    assert f1 == pytest.approx((6 / 7 + 1.0) / 2)


def test_cross_day_accuracy():
    # 群诉 G 跨日（D1 与 D2），正确合并→1.0
    assert cross_day_accuracy(multi_window_groups={"G": True}, merged={"G": True}) == 1.0
    assert cross_day_accuracy(multi_window_groups={"G": True}, merged={"G": False}) == 0.0


def test_min_sensitivity_small_groups():
    small = {"G1": {"T1", "T2", "T3"}, "G2": {"T5", "T6", "T7"}}
    found = {"G1"}                    # 只发现 G1
    assert min_sensitivity(small, found) == pytest.approx(0.5)
