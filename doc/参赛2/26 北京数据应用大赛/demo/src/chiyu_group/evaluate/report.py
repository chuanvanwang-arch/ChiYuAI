"""评测报告生成（Markdown/JSON）。"""


def build_report(metrics: dict) -> dict:
    md = f"""# 评测报告
- 宏平均 F1: {metrics.get('macro_f1'):.4f}
- 跨日合并准确率: {metrics.get('cross_day_acc'):.4f}
- 最小成诉敏感度: {metrics.get('min_sensitivity'):.4f}
- 单条耗时 P50: {metrics.get('latency_ms_p50')}ms / P95: {metrics.get('latency_ms_p95')}ms
"""
    return {"markdown": md, "json": metrics}
