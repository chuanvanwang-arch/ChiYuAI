"""1 项生成式软评分（成因一致性）。默认关闭；启用时由本地 LLM 判断，
DEMO 以确定性占位（default），接口保留。"""


def soft_score(text_a: str, text_b: str, enabled: bool = False,
               default: float = 0.7) -> float | None:
    if not enabled:
        return None
    # DEMO：未接入 LLM 时返回可配置默认值；接入后替换为本地模型推理
    return default
