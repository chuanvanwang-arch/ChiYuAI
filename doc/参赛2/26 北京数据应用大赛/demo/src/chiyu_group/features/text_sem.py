"""文本语义特征：关键词 Jaccard + 稠密向量余弦（bge/哈希降级）。"""
import re

import numpy as np

from chiyu_group.features.infer import InferBackend, cosine

_STOP = {"的", "了", "在", "是", "和", "与", "及", "对", "就", "也", "都",
         "这个", "那个", "一个", "问题", "反映", "市民", "希望", "请", "要求"}


def _kw(text: str) -> set:
    # 中文：1-2 字窗口滑窗（含单字与二元组，停用词过滤）；英文单词整词
    toks = []
    for w in re.findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fa5]", text or ""):
        toks.append(w)
    cjk = [c for c in text or "" if "\u4e00" <= c <= "\u9fa5"]
    toks += [cjk[i] + cjk[i + 1] for i in range(len(cjk) - 1)]
    return {t for t in toks if t not in _STOP and len(t) >= 2}


def keyword_jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


def text_features(backend: InferBackend | None = None, text: str = "") -> dict:
    """返回文本特征包：关键词集 + 向量。"""
    backend = backend or InferBackend(backend="none")
    return {"vec": backend.encode(text), "kws": _kw(text)}
