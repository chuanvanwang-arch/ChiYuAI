from chiyu_group.evaluate.report import build_report


def test_report_markdown_and_json():
    rep = build_report({"macro_f1": 0.85, "cross_day_acc": 0.9, "min_sensitivity": 0.8,
                        "latency_ms_p50": 45, "latency_ms_p95": 120})
    assert "0.85" in rep["markdown"]
    assert rep["json"]["macro_f1"] == 0.85
